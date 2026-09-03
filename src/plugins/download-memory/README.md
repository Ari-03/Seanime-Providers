# Download Memory

Stops Seanime's Auto Downloader from re-downloading episodes you already have.

## The problem

You download a season, then Shoko (or Sonarr, or a rename script) imports it: the files get renamed and moved to the folder Jellyfin reads from. The next time Seanime scans, those files are gone from its library, so the Auto Downloader sees the episodes as missing and downloads them again. Duplicates, wasted disk.

Seanime only treats an episode as handled if one of these is true right now:

- a matching file is in the library
- your AniList progress already covers the episode
- a queue entry for it exists (these are deleted after every scan)
- the torrent is still in the torrent client

None of that survives an external tool moving the file, and there is no setting for it.

## How it works

The plugin keeps a ledger of every episode that has ever been downloaded, and vetoes the Auto Downloader when it picks one of them again. The ledger is filled from three sources:

1. **Library scans.** Every episode file a scan finds is remembered, so a batch that was in the library even once stays remembered after Shoko moves it.
2. **The Auto Downloader itself.** Every torrent it sends to your torrent client is remembered immediately, before the file even exists.
3. **Shoko Server** (optional). Asks Shoko which episodes it already has a file for, for every anime that has an Auto Downloader rule. This also covers files Shoko grabbed before Seanime ever scanned them.

The ledger only ever grows. If you deliberately delete an episode and want it downloaded again, forget that anime from the tray.

With **Hide remembered episodes** on, remembered episodes also disappear from the "missing episodes" list on the home screen and from the download list on the anime page.

## Setup

1. Add the extension in Seanime under `Settings > Extensions` with this manifest URL:

   ```
   https://raw.githubusercontent.com/Ari-03/Seanime-Providers/main/src/plugins/download-memory/manifest.json
   ```

2. Grant the `storage` and `database` permissions and the network permission. The network permission is only used for your own Shoko Server, and only if you turn Shoko sync on.

3. On first load the plugin remembers everything currently in your library. You are protected from that point on.

### Shoko sync (recommended for the Shoko + Jellyfin setup)

Open the tray icon:

1. Turn on **Sync episodes Shoko already has**.
2. Enter the Shoko URL. The default is `http://127.0.0.1:8111`.
3. Either paste an API key, or type your Shoko username and password and press **Get key**. The password is sent to Shoko once to create a key and is never stored.
4. Press **Test connection**, then **Sync now**.

Sync runs on the interval you pick, right after every library scan, and about 20 seconds after Seanime starts. Only anime with an Auto Downloader rule are checked, since those are the only ones the Auto Downloader can act on. The tray shows when the last sync ran and which anime were skipped.

Anime are matched to Shoko through the AniDB ID in Seanime's own metadata. Episode numbers are translated the same way Seanime does it, so shows where AniDB and AniList disagree about episode 0 or specials still line up.

## The tray

- **Enabled** turns the veto on or off without losing the ledger.
- **Recently blocked** lists the downloads the plugin stopped. Entries marked *preview run* came from the Auto Downloader's preview mode, which the plugin filters too so the preview is accurate.
- **Remember current library** re-reads the library on demand.
- **Forget an anime** drops one anime from the ledger.
- **Clear everything** empties the ledger.

The badge on the tray icon counts real blocked downloads since you last opened it.

## Good to know

- Batch torrents never go through the Auto Downloader, so the plugin only ever has to reason about single episodes.
- Episodes you have watched on AniList are already skipped by Seanime itself, with or without this plugin.
- If the Auto Downloader is set to queue instead of downloading immediately, an episode is remembered when its file is scanned or when Shoko reports it, not when it is queued.
- An alternative without a plugin is to add Shoko's destination folder as an extra library path in Seanime, so Seanime keeps seeing the files. That only works if Seanime can parse Shoko's renamed file names correctly, which is not a given for multi-season shows.
- Requires Seanime 3.7.1 or newer.
