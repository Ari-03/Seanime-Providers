/// <reference path="./plugin.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

// Download Memory
//
// Stops the Auto Downloader from re-downloading episodes that were already downloaded but have
// since been moved out of the library by an external tool (Shoko, Sonarr, a rename script...).
//
// Seanime decides that an episode is missing by looking at the files that are in the library
// *right now*. This plugin keeps its own memory (a ledger) of every episode that has ever been
// downloaded and vetoes the Auto Downloader when it picks one of them again.
//
// Ledger sources
//   1. Library scans            every "main" episode file a scan finds (onScanCompleted)
//   2. Auto Downloader          every torrent it actually sends to the torrent client
//   3. Shoko Server (optional)  every episode Shoko already has a file for
//
// Ledger guards
//   1. onAutoDownloaderBestCandidateSelected  vetoes the episode before anything is queued
//   2. onAutoDownloaderBeforeDownloadTorrent  last line of defense, also covers delayed queue items
//   3. onAnimeEntryDownloadInfo               hides remembered episodes from "missing" lists (optional)
//
// Hooks and the UI context run in isolated runtimes, so helpers live in a $shared module and all
// state lives in $storage:
//   config              plugin settings (see DEFAULTS)
//   ledger:<mediaId>    { title?, eps: { "<episode>": { src, at, name? } } }
//   blocked             last 30 vetoed downloads, newest first
//   blocked-unseen      vetoes since the tray was last opened (drives the badge)
//   shoko-series:<id>   cached Shoko series ID per AniList media ID
//   shoko-last-sync     one-line summary of the last Shoko sync

type LedgerSource = "scan" | "auto" | "shoko" | "library"

interface LedgerEntry {
    src: LedgerSource
    at: number
    name?: string
}

interface MediaLedger {
    title?: string
    eps: Record<string, LedgerEntry>
}

interface Config {
    enabled: boolean
    hideFromUi: boolean
    shokoEnabled: boolean
    shokoUrl: string
    shokoApiKey: string
    shokoIntervalMin: number
}

interface BlockedDownload {
    mediaId: number
    title: string
    episode: number
    torrent: string
    at: number
    simulated: boolean
}

// What $shared.use("ledger") returns in every runtime
interface Ledger {
    config(): Config
    saveConfig(cfg: Config): void
    episodes(mediaId: number): Record<string, LedgerEntry>
    has(mediaId: number, episode: number): boolean
    add(mediaId: number, episodes: number[], src: LedgerSource, name?: string, title?: string): number
    rememberFiles(files: $app.Anime_LocalFile[], src: LedgerSource): number
    forget(mediaId: number): void
    clear(): void
    all(): Record<string, MediaLedger>
    logBlocked(entry: BlockedDownload): void
}

// Shoko Server API v3 shapes (only the fields we read)
interface ShokoSeries {
    IDs?: { ID?: number }
}

interface ShokoEpisode {
    Size?: number
    AniDB?: { EpisodeNumber?: number; Type?: string }
}

interface ShokoList<T> {
    Total?: number
    List?: T[]
}

function init() {

    // The factory is re-run inside each runtime that calls $shared.use, so it must be self-contained.
    $shared.define<Ledger>("ledger", () => {
        const DEFAULTS: Config = {
            enabled: true,
            hideFromUi: true,
            shokoEnabled: false,
            shokoUrl: "http://127.0.0.1:8111",
            shokoApiKey: "",
            shokoIntervalMin: 15,
        }
        const PREFIX = "ledger:"

        function read(mediaId: number): MediaLedger {
            const stored = $storage.get<MediaLedger>(PREFIX + mediaId)
            return stored && stored.eps ? stored : { eps: {} }
        }

        function add(mediaId: number, episodes: number[], src: LedgerSource, name?: string, title?: string): number {
            const ledger = read(mediaId)
            let added = 0
            for (const episode of episodes) {
                const key = String(episode)
                if (!(episode >= 0) || ledger.eps[key]) continue
                ledger.eps[key] = name ? { src, at: Date.now(), name } : { src, at: Date.now() }
                added++
            }
            const titleChanged = !!title && !ledger.title
            if (titleChanged) ledger.title = title
            if (added > 0 || titleChanged) $storage.set(PREFIX + mediaId, ledger)
            return added
        }

        return {
            config() {
                const stored = $storage.get<Partial<Config>>("config") || {}
                return {
                    enabled: stored.enabled ?? DEFAULTS.enabled,
                    hideFromUi: stored.hideFromUi ?? DEFAULTS.hideFromUi,
                    shokoEnabled: stored.shokoEnabled ?? DEFAULTS.shokoEnabled,
                    shokoUrl: stored.shokoUrl ?? DEFAULTS.shokoUrl,
                    shokoApiKey: stored.shokoApiKey ?? DEFAULTS.shokoApiKey,
                    shokoIntervalMin: stored.shokoIntervalMin ?? DEFAULTS.shokoIntervalMin,
                }
            },
            saveConfig(cfg) {
                $storage.set("config", cfg)
            },
            episodes(mediaId) {
                return read(mediaId).eps
            },
            has(mediaId, episode) {
                return !!read(mediaId).eps[String(episode)]
            },
            add,
            // Records every "main" episode file of a local file list, grouped per anime
            rememberFiles(files, src) {
                const byMedia: Record<string, number[]> = {}
                const titles: Record<string, string> = {}
                for (const lf of files) {
                    if (!lf.mediaId || !lf.metadata || lf.metadata.type !== "main") continue
                    const key = String(lf.mediaId)
                    if (!byMedia[key]) byMedia[key] = []
                    byMedia[key].push(lf.metadata.episode)
                    if (!titles[key]) {
                        const folder = lf.parsedFolderInfo && lf.parsedFolderInfo[0]
                        titles[key] = (folder && folder.title) || (lf.parsedInfo && lf.parsedInfo.title) || ""
                    }
                }
                let added = 0
                for (const key in byMedia) added += add(Number(key), byMedia[key], src, undefined, titles[key])
                return added
            },
            forget(mediaId) {
                $storage.remove(PREFIX + mediaId)
            },
            clear() {
                for (const key of $storage.keys()) {
                    if (key.indexOf(PREFIX) === 0) $storage.remove(key)
                }
            },
            all() {
                const out: Record<string, MediaLedger> = {}
                for (const key of $storage.keys()) {
                    if (key.indexOf(PREFIX) !== 0) continue
                    const mediaId = key.slice(PREFIX.length)
                    out[mediaId] = read(Number(mediaId))
                }
                return out
            },
            logBlocked(entry) {
                const list = $storage.get<BlockedDownload[]>("blocked") || []
                list.unshift(entry)
                $storage.set("blocked", list.slice(0, 30))
                if (!entry.simulated) {
                    $storage.set("blocked-unseen", ($storage.get<number>("blocked-unseen") || 0) + 1)
                }
                $store.set("download-memory:blocked", Date.now())
            },
        }
    })

    // ------------------------------------------------------------------ sources

    // Every "main" episode file a scan finds. Fires before the result is written to the database.
    $app.onScanCompleted((e) => {
        try {
            const added = $shared.use<Ledger>("ledger").rememberFiles(e.localFiles || [], "scan")
            if (added > 0) console.log(`download-memory: remembered ${added} episode(s) from the library scan`)
            $store.set("download-memory:scan", Date.now())
        } catch (err) {
            console.error("download-memory: onScanCompleted", err)
        }
        e.next()
    })

    // Every torrent the Auto Downloader actually hands to the torrent client
    $app.onAutoDownloaderAfterDownloadTorrent((e) => {
        try {
            if (e.downloaded && !e.isSimulation && e.rule && e.rule.mediaId > 0 && e.episode > 0) {
                const name = e.torrent ? e.torrent.name : undefined
                $shared.use<Ledger>("ledger").add(e.rule.mediaId, [e.episode], "auto", name, e.rule.comparisonTitle)
            }
        } catch (err) {
            console.error("download-memory: onAutoDownloaderAfterDownloadTorrent", err)
        }
        e.next()
    })

    // ------------------------------------------------------------------ guards

    // Fires once per rule and episode, before anything is queued, delayed or downloaded
    $app.onAutoDownloaderBestCandidateSelected((e) => {
        try {
            const ledger = $shared.use<Ledger>("ledger")
            if (e.rule && ledger.config().enabled && ledger.has(e.rule.mediaId, e.episode)) {
                // Untagged Go fields reach the runtime in lowerCamel, the typings say `Torrent`
                const candidate = e.candidate as ($app.AutoDownloader_Candidate & { torrent?: $app.AutoDownloader_NormalizedTorrent }) | undefined
                const torrent = candidate && (candidate.torrent || candidate.Torrent)
                ledger.logBlocked({
                    mediaId: e.rule.mediaId,
                    title: e.rule.comparisonTitle,
                    episode: e.episode,
                    torrent: torrent ? torrent.name : "",
                    at: Date.now(),
                    simulated: e.isSimulation,
                })
                e.preventDefault()
            }
        } catch (err) {
            console.error("download-memory: onAutoDownloaderBestCandidateSelected", err)
        }
        e.next()
    })

    // Delayed queue items skip candidate selection, so check again right before the download
    $app.onAutoDownloaderBeforeDownloadTorrent((e) => {
        try {
            const ledger = $shared.use<Ledger>("ledger")
            if (e.rule && ledger.config().enabled && ledger.has(e.rule.mediaId, e.episode)) {
                ledger.logBlocked({
                    mediaId: e.rule.mediaId,
                    title: e.rule.comparisonTitle,
                    episode: e.episode,
                    torrent: e.torrent ? e.torrent.name : "",
                    at: Date.now(),
                    simulated: e.isSimulation,
                })
                e.preventDefault()
            }
        } catch (err) {
            console.error("download-memory: onAutoDownloaderBeforeDownloadTorrent", err)
        }
        e.next()
    })

    // Drops remembered episodes from an anime's "episodes to download". The home screen's
    // missing-episodes list is built from the same data, so it is filtered as well.
    $app.onAnimeEntryDownloadInfo((e) => {
        try {
            const info = e.entryDownloadInfo
            const toDownload = info && info.episodesToDownload
            if (info && toDownload && toDownload.length > 0) {
                const ledger = $shared.use<Ledger>("ledger")
                const cfg = ledger.config()
                const first = toDownload[0].episode
                const mediaId = first && first.baseAnime ? first.baseAnime.id : 0
                if (cfg.enabled && cfg.hideFromUi && mediaId > 0) {
                    const remembered = ledger.episodes(mediaId)
                    info.episodesToDownload = toDownload.filter((d) => !remembered[String(d.episodeNumber)])
                }
            }
        } catch (err) {
            console.error("download-memory: onAnimeEntryDownloadInfo", err)
        }
        e.next()
    })

    // ------------------------------------------------------------------ UI

    $ui.register((ctx) => {
        const ledger = $shared.use<Ledger>("ledger")
        const cfg = ledger.config()

        const tray = ctx.newTray({
            iconUrl: "https://raw.githubusercontent.com/5rahim/seanime/main/seanime-web/public/logo_2.png",
            withContent: true,
            width: "440px",
        })

        const summary = ctx.state({ anime: 0, episodes: 0 })
        const blocked = ctx.state<BlockedDownload[]>([])
        const mediaOptions = ctx.state<{ label: string; value: string }[]>([])
        const lastSync = ctx.state("never")
        const syncing = ctx.state(false)

        function errMsg(err: unknown): string {
            return err instanceof Error ? err.message : String(err)
        }

        function save<K extends keyof Config>(key: K, value: Config[K]) {
            cfg[key] = value
            ledger.saveConfig(cfg)
        }

        // Rule titles are the most readable names we have for an anime
        function ruleTitles(): Record<string, string> {
            const titles: Record<string, string> = {}
            try {
                for (const rule of $database.autoDownloaderRules.getAll()) titles[String(rule.mediaId)] = rule.comparisonTitle
            } catch (err) {
                // database permission not granted, fall back to stored titles
            }
            return titles
        }

        function updateBadge() {
            tray.updateBadge({ number: $storage.get<number>("blocked-unseen") || 0, intent: "info" })
        }

        function refresh() {
            const all = ledger.all()
            const titles = ruleTitles()
            const options: { label: string; value: string }[] = []
            let episodes = 0
            for (const mediaId in all) {
                const count = Object.keys(all[mediaId].eps).length
                episodes += count
                options.push({ label: `${titles[mediaId] || all[mediaId].title || "#" + mediaId} (${count})`, value: mediaId })
            }
            options.sort((a, b) => a.label.localeCompare(b.label))
            summary.set({ anime: options.length, episodes })
            mediaOptions.set(options)
            blocked.set($storage.get<BlockedDownload[]>("blocked") || [])
            lastSync.set($storage.get<string>("shoko-last-sync") || "never")
            updateBadge()
        }

        // ---- settings fields

        const enabledRef = ctx.fieldRef<boolean>(cfg.enabled)
        enabledRef.onValueChange((value) => save("enabled", value))

        const hideRef = ctx.fieldRef<boolean>(cfg.hideFromUi)
        hideRef.onValueChange((value) => save("hideFromUi", value))

        const shokoEnabledRef = ctx.fieldRef<boolean>(cfg.shokoEnabled)
        shokoEnabledRef.onValueChange((value) => {
            save("shokoEnabled", value)
            scheduleSync()
        })

        const shokoUrlRef = ctx.fieldRef<string>(cfg.shokoUrl)
        shokoUrlRef.onValueChange((value) => save("shokoUrl", value.trim()))

        const shokoKeyRef = ctx.fieldRef<string>(cfg.shokoApiKey)
        shokoKeyRef.onValueChange((value) => save("shokoApiKey", value.trim()))

        const shokoIntervalRef = ctx.fieldRef<string>(String(cfg.shokoIntervalMin))
        shokoIntervalRef.onValueChange((value) => {
            save("shokoIntervalMin", Number(value) || 15)
            scheduleSync()
        })

        const shokoUserRef = ctx.fieldRef<string>("")
        const shokoPassRef = ctx.fieldRef<string>("")
        const forgetRef = ctx.fieldRef<string>("")

        // ---- Shoko Server

        function shokoBase(): string {
            return cfg.shokoUrl.replace(/\/+$/, "")
        }

        // Returns undefined on 404 so callers can treat "not in Shoko" as a normal case
        async function shokoGet<T>(path: string): Promise<T | undefined> {
            const res = await ctx.fetch(shokoBase() + path, {
                headers: { apikey: cfg.shokoApiKey, Accept: "application/json" },
                timeout: 30,
            })
            if (res.status === 404) return undefined
            if (res.status === 401 || res.status === 403) throw new Error("Shoko rejected the API key")
            if (!res.ok) throw new Error(`Shoko returned ${res.status} for ${path}`)
            return res.json<T>()
        }

        // Exchanges a username and password for a permanent API key
        async function shokoLogin(user: string, pass: string): Promise<string> {
            const res = await ctx.fetch(shokoBase() + "/api/auth", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ user, pass, device: "Seanime Download Memory" }),
                timeout: 30,
            })
            if (res.status === 401) throw new Error("Shoko rejected the username or password")
            if (!res.ok) throw new Error(`Shoko login failed (${res.status})`)
            const key = res.json<{ apikey?: string }>().apikey
            if (!key) throw new Error("Shoko did not return an API key")
            return key
        }

        // AniList media -> Shoko series, through the AniDB ID in Seanime's metadata. Cached forever.
        async function shokoSeriesId(mediaId: number, meta: $app.Metadata_AnimeMetadata | undefined): Promise<number | undefined> {
            const cacheKey = "shoko-series:" + mediaId
            const cached = $storage.get<number>(cacheKey)
            if (cached) return cached
            const anidbId = meta && meta.mappings ? meta.mappings.anidbId : undefined
            if (!anidbId) throw new Error("no AniDB mapping in Seanime's metadata")
            const series = await shokoGet<ShokoSeries>(`/api/v3/Series/AniDB/${anidbId}/Series`)
            const id = series && series.IDs ? series.IDs.ID : undefined
            if (id) $storage.set(cacheKey, id)
            return id
        }

        function pickTitle(meta: $app.Metadata_AnimeMetadata | undefined): string | undefined {
            const titles = meta && meta.titles
            if (!titles) return undefined
            return titles["en"] || titles["x-jat"] || titles[Object.keys(titles)[0]]
        }

        // Only anime with a rule can be auto-downloaded, so those are the ones worth checking
        function ruleMediaIds(): number[] {
            const ids: number[] = []
            for (const rule of $database.autoDownloaderRules.getAll()) {
                if (rule.mediaId > 0 && ids.indexOf(rule.mediaId) === -1) ids.push(rule.mediaId)
            }
            return ids
        }

        async function syncShoko(manual: boolean) {
            if (syncing.get()) {
                if (manual) ctx.toast.info("A Shoko sync is already running")
                return
            }
            if (!cfg.shokoEnabled || !cfg.shokoUrl || !cfg.shokoApiKey) {
                if (manual) ctx.toast.warning("Turn on Shoko sync and fill in the URL and API key first")
                return
            }
            syncing.set(true)
            let added = 0
            let synced = 0
            let total = 0
            const skipped: string[] = []
            try {
                const mediaIds = ruleMediaIds()
                total = mediaIds.length
                for (const mediaId of mediaIds) {
                    try {
                        const meta = await ctx.anime.getAnimeMetadata("anilist", mediaId)
                        const seriesId = await shokoSeriesId(mediaId, meta)
                        if (!seriesId) {
                            skipped.push(`#${mediaId} not in Shoko`)
                            continue
                        }
                        // Default filters already drop episodes without files; Size is the file count
                        const page = await shokoGet<ShokoList<ShokoEpisode>>(
                            `/api/v3/Series/${seriesId}/Episode?pageSize=0&type=Episode&includeDataFrom=AniDB&includeHidden=true`,
                        )
                        const episodes: number[] = []
                        for (const ep of (page && page.List) || []) {
                            const anidbNumber = ep.AniDB ? ep.AniDB.EpisodeNumber : undefined
                            if (!anidbNumber || (ep.Size !== undefined && ep.Size <= 0)) continue
                            // Shoko counts AniDB episodes, Seanime's metadata maps them to AniList numbers
                            const mapped = meta && meta.episodes && meta.episodes[String(anidbNumber)]
                            episodes.push(mapped && mapped.episodeNumber ? mapped.episodeNumber : anidbNumber)
                        }
                        added += ledger.add(mediaId, episodes, "shoko", undefined, pickTitle(meta))
                        synced++
                    } catch (err) {
                        skipped.push(`#${mediaId} ${errMsg(err)}`)
                    }
                }
                const when = new Date().toLocaleString()
                const skippedText = skipped.length > 0 ? ` · skipped ${skipped.join("; ")}` : ""
                $storage.set("shoko-last-sync", `${when} · ${synced}/${total} anime · +${added} episodes${skippedText}`)
                if (manual) ctx.toast.success(`Shoko sync done, ${added} new episode(s) remembered`)
                if (added > 0) $app.invalidateClientQuery(["ANIME-ENTRIES-get-missing-episodes"])
            } catch (err) {
                $storage.set("shoko-last-sync", `${new Date().toLocaleString()} · failed: ${errMsg(err)}`)
                if (manual) ctx.toast.error("Shoko sync failed: " + errMsg(err))
            } finally {
                syncing.set(false)
                refresh()
            }
        }

        let cancelSync: (() => void) | undefined
        function scheduleSync() {
            if (cancelSync) {
                cancelSync()
                cancelSync = undefined
            }
            if (!cfg.shokoEnabled) return
            const minutes = Math.max(1, cfg.shokoIntervalMin || 15)
            cancelSync = ctx.setInterval(() => {
                syncShoko(false)
            }, minutes * 60 * 1000)
        }

        // ---- event handlers

        ctx.registerEventHandler("sync-now", () => {
            syncShoko(true)
        })

        ctx.registerEventHandler("test-shoko", async () => {
            try {
                if (!cfg.shokoUrl || !cfg.shokoApiKey) throw new Error("fill in the URL and API key first")
                await shokoGet<unknown>("/api/v3/Series?pageSize=1&page=1")
                ctx.toast.success("Shoko is reachable and the API key works")
            } catch (err) {
                ctx.toast.error("Shoko test failed: " + errMsg(err))
            }
        })

        ctx.registerEventHandler("shoko-login", async () => {
            try {
                if (!cfg.shokoUrl) throw new Error("fill in the Shoko URL first")
                const key = await shokoLogin(shokoUserRef.current || "", shokoPassRef.current || "")
                shokoKeyRef.setValue(key)
                save("shokoApiKey", key)
                shokoPassRef.setValue("")
                ctx.toast.success("Shoko API key saved")
            } catch (err) {
                ctx.toast.error(errMsg(err))
            }
        })

        ctx.registerEventHandler("remember-library", () => {
            try {
                const added = ledger.rememberFiles($database.localFiles.getAll(), "library")
                ctx.toast.success(`Remembered ${added} new episode(s) from the current library`)
                refresh()
            } catch (err) {
                ctx.toast.error("Could not read the library: " + errMsg(err))
            }
        })

        ctx.registerEventHandler("forget", () => {
            const mediaId = Number(forgetRef.current)
            if (!mediaId) return
            ledger.forget(mediaId)
            forgetRef.setValue("")
            refresh()
            $app.invalidateClientQuery(["ANIME-ENTRIES-get-missing-episodes"])
            ctx.toast.info("Forgot that anime, its episodes can be downloaded again")
        })

        ctx.registerEventHandler("clear-all", () => {
            ledger.clear()
            $storage.remove("blocked")
            $storage.set("blocked-unseen", 0)
            refresh()
            $app.invalidateClientQuery(["ANIME-ENTRIES-get-missing-episodes"])
            ctx.toast.info("Download memory cleared")
        })

        // ---- wiring

        tray.onOpen(() => {
            $storage.set("blocked-unseen", 0)
            refresh()
        })

        $store.watch<number>("download-memory:blocked", () => {
            blocked.set($storage.get<BlockedDownload[]>("blocked") || [])
            updateBadge()
        })

        // A scan means files just appeared or vanished, a good moment to ask Shoko what it has
        $store.watch<number>("download-memory:scan", () => {
            refresh()
            if (cfg.shokoEnabled) syncShoko(false)
        })

        // First run: seed the ledger with whatever is in the library right now
        if (Object.keys(ledger.all()).length === 0) {
            try {
                ledger.rememberFiles($database.localFiles.getAll(), "library")
            } catch (err) {
                console.error("download-memory: could not seed from the library", err)
            }
        }

        scheduleSync()
        if (cfg.shokoEnabled) {
            ctx.setTimeout(() => {
                syncShoko(false)
            }, 20 * 1000)
        }
        refresh()

        // ---- render

        const INTERVALS = [
            { label: "5 minutes", value: "5" },
            { label: "15 minutes", value: "15" },
            { label: "30 minutes", value: "30" },
            { label: "60 minutes", value: "60" },
        ]

        tray.render(() => {
            const s = summary.get()
            const recent = blocked.get().slice(0, 8)

            return tray.stack([
                tray.text(`Remembering ${s.episodes} episode(s) across ${s.anime} anime.`, { className: "text-sm text-[--muted]" }),
                tray.switch("Enabled", { fieldRef: enabledRef }),
                tray.checkbox("Hide remembered episodes from missing/download lists", { fieldRef: hideRef }),

                tray.text("Shoko Server", { className: "text-sm font-semibold pt-2" }),
                tray.switch("Sync episodes Shoko already has", { fieldRef: shokoEnabledRef }),
                tray.input("URL", { fieldRef: shokoUrlRef, placeholder: "http://127.0.0.1:8111" }),
                tray.input("API key", { fieldRef: shokoKeyRef, placeholder: "Paste a key, or log in below to create one" }),
                tray.flex([
                    tray.input("Username", { fieldRef: shokoUserRef }),
                    tray.input("Password", { fieldRef: shokoPassRef }),
                    tray.button("Get key", { onClick: "shoko-login", intent: "gray-subtle", size: "sm" }),
                ], { gap: 2, style: { alignItems: "flex-end" } }),
                tray.select("Sync every", { options: INTERVALS, fieldRef: shokoIntervalRef }),
                tray.flex([
                    tray.button("Sync now", { onClick: "sync-now", intent: "primary-subtle", size: "sm", loading: syncing.get() }),
                    tray.button("Test connection", { onClick: "test-shoko", intent: "gray-subtle", size: "sm" }),
                ], { gap: 2 }),
                tray.text(`Last sync: ${lastSync.get()}`, { className: "text-xs text-[--muted]" }),

                tray.text("Recently blocked", { className: "text-sm font-semibold pt-2" }),
                ...(recent.length === 0
                    ? [tray.text("Nothing yet.", { className: "text-xs text-[--muted]" })]
                    : recent.map((b) => tray.text(
                        `${b.title || "#" + b.mediaId} · Episode ${b.episode}${b.simulated ? " (preview run)" : ""}`,
                        { className: "text-xs" },
                    ))),

                tray.text("Maintenance", { className: "text-sm font-semibold pt-2" }),
                tray.button("Remember current library", { onClick: "remember-library", intent: "gray-subtle", size: "sm" }),
                tray.select("Forget an anime", { options: mediaOptions.get(), fieldRef: forgetRef, placeholder: "Pick an anime" }),
                tray.flex([
                    tray.button("Forget selected", { onClick: "forget", intent: "warning-subtle", size: "sm" }),
                    tray.button("Clear everything", { onClick: "clear-all", intent: "alert-subtle", size: "sm" }),
                ], { gap: 2 }),
            ], { style: { gap: "0.35rem" } })
        })
    })
}
