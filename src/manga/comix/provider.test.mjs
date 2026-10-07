import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
    new URL("./provider.js", import.meta.url),
    "utf8",
);
const securitySource = `globalThis.vmFixture = { install(client) {
    client.interceptors.request.use(config => ({...config, params: {...config.params, _: 'current-token'}}));
    client.interceptors.response.use(response => ({...response, data: JSON.parse(response.data.e)}));
}}; export { }`;
const reply = (body, status = 200, headers = {}) => ({
    status,
    headers,
    text: () => (typeof body === "string" ? body : JSON.stringify(body)),
});

function setup(route, preferences = {}, initial = {}) {
    const store = new Map(Object.entries(initial));
    const calls = [];
    const context = vm.createContext({
        URL,
        console: { log() {}, warn() {}, error() {} },
        $getUserPreference: (key) => preferences[key],
        $store: {
            get: (key) => store.get(key),
            set: (key, value) => store.set(key, value),
            remove: (key) => store.delete(key),
        },
        $sleep() {},
        fetch: async (url, options) => {
            calls.push({ url, options });
            if (url === "https://comix.to")
                return reply(
                    '<title>Comix</title><script src="/assets/dist/main-current.js"></script><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>',
                );
            if (url.endsWith("main-current.js"))
                return reply('import "./secure-current.js"');
            if (url.endsWith("secure-current.js")) return reply(securitySource);
            return route(url, options);
        },
    });
    vm.runInContext(`${source}\nthis.provider = new Provider();`, context);
    return { provider: context.provider, calls, store, context };
}

function chapter(id, number = id) {
    return { id, number, language: "en", group: { name: "Group" } };
}

test("loads current security module without preferences or Chrome, and keeps browser globals private", async () => {
    const { provider, calls, context } = setup(() =>
        reply({
            status: "ok",
            result: {
                items: [
                    {
                        hid: "abc",
                        slug: "abc-title",
                        title: "Title",
                        poster: { large: "https://static.comix.to/cover.jpg" },
                    },
                ],
            },
        }),
    );
    const result = await provider.search({ query: "title & more" });
    assert.equal(result[0].id, "abc|title");
    assert.equal(context.window, undefined);
    assert.equal(context.navigator, undefined);
    const request = calls.at(-1);
    assert.match(request.url, /keyword=title%20%26%20more/);
    assert.match(request.url, /order%5Brelevance%5D=desc/);
    assert.match(request.url, /_=current-token/);
    assert.equal(request.options.headers.Cookie, undefined);
    assert.equal(result[0].imageHeaders.Cookie, undefined);
    assert.equal(
        calls[2].url,
        "https://comix.to/assets/dist/secure-current.js",
    );
});

test("decodes x-enc 2 direct chapter lists, paginates, deduplicates and sorts", async () => {
    const { provider } = setup((url) => {
        const page = new URL(url).searchParams.get("page");
        const items =
            page === "1" ? [chapter(2), chapter(1)] : [chapter(2), chapter(3)];
        return reply(
            { e: JSON.stringify({ items, meta: { lastPage: 2 } }) },
            200,
            {
                "X-Enc": "2",
            },
        );
    });
    const chapters = await provider.findChapters("abc|title");
    assert.deepEqual(
        Array.from(chapters, (item) => item.chapter),
        ["1", "2", "3"],
    );
    assert.deepEqual(
        Array.from(chapters, (item) => item.index),
        [0, 1, 2],
    );
});

test("normalizes direct chapter pages and preserves proxy headers without Referer", async () => {
    const { provider } = setup(() =>
        reply(
            {
                e: JSON.stringify({
                    pages: {
                        baseUrl: "https://images.example/base/",
                        items: [
                            { url: "one.jpg" },
                            { url: "https://images.example/two.jpg" },
                        ],
                    },
                }),
            },
            200,
            { "x-enc": "2" },
        ),
    );
    const pages = await provider.findChapterPages("abc|title|123|1");
    assert.equal(pages[0].url, "https://images.example/base/one.jpg");
    assert.equal(pages[1].url, "https://images.example/two.jpg");
    assert.ok(pages[0].headers.Accept);
    assert.equal(pages[0].headers.Referer, undefined);
});

test("refreshes rejected cached module once", async () => {
    let requests = 0;
    const { provider, calls } = setup(
        () =>
            ++requests === 1
                ? reply({ code: "invalid_token" }, 403)
                : reply({ items: [] }),
        {},
        {
            "comix:security-module:v3": JSON.stringify({
                source: securitySource,
            }),
        },
    );
    await provider.apiGet("/manga", {});
    assert.equal(requests, 2);
    assert.equal(
        calls.filter((call) => call.url.endsWith("secure-current.js")).length,
        1,
    );
});

test("repeated token rejection and undecoded ciphertext fail with visible messages", async () => {
    const rejected = setup(() => reply({ message: "Invalid token." }, 403));
    await assert.rejects(
        rejected.provider.apiGet("/manga", {}),
        (error) =>
            typeof error === "string" && /still rejects tokens/.test(error),
    );
    const encrypted = setup(() =>
        reply({ e: '{"e":"unhandled"}' }, 200, { "x-enc": "3" }),
    );
    await assert.rejects(
        encrypted.provider.apiGet("/chapters/1", {}),
        (error) => typeof error === "string" && /could not decode/.test(error),
    );
});

test("malformed chapter list fails instead of returning partial cached chapters", async () => {
    const { provider } = setup(() => reply({ meta: { lastPage: 1 } }));
    await assert.rejects(provider.findChapters("abc|title"), (error) =>
        /no result.items list/.test(error),
    );
});

test("manual cookie settings remain optional but must be paired", async () => {
    const { provider, calls } = setup(() => reply({ items: [] }), {
        cfClearance: "cf_clearance=example;",
        userAgent: "Matching browser",
    });
    await provider.apiGet("/manga", {});
    assert.equal(calls.at(-1).options.headers.Cookie, "cf_clearance=example");
    assert.equal(
        calls.at(-1).options.headers["User-Agent"],
        "Matching browser",
    );
    const partial = setup(() => reply({}), { cfClearance: "example" });
    assert.throws(
        () => partial.provider.readCredentials(),
        (error) => /supply both/.test(error),
    );
});

test("challenge setup captures a cookie and matching UA once for concurrent calls", async () => {
    let browsers = 0,
        closes = 0;
    const { provider, context, store } = setup((_url, options) =>
        options.headers.Cookie
            ? reply({ items: [] })
            : reply("<title>Just a moment</title>", 403),
    );
    context.ChromeDP = {
        newBrowser: async (options) => {
            browsers++;
            assert.equal(options.headless, false);
            return {
                navigate: async () => {},
                evaluate: async () =>
                    JSON.stringify({
                        title: "Comix",
                        userAgent: "Captured browser",
                    }),
                executeCDP: async () => ({
                    cookies: [
                        {
                            name: "cf_clearance",
                            value: "captured",
                            expires: Date.now() / 1000 + 3600,
                        },
                    ],
                }),
                close: async () => {
                    closes++;
                },
            };
        },
    };
    await Promise.all([
        provider.apiGet("/manga", {}),
        provider.apiGet("/manga", {}),
    ]);
    assert.equal(browsers, 1);
    assert.equal(closes, 1);
    assert.equal(
        JSON.parse(store.get("comix:browser-session:v3")).userAgent,
        "Captured browser",
    );
    assert.equal(store.has("comix:session-lease:v3"), false);
});

test("browser setup survives a Cloudflare reload during polling", async () => {
    const { provider, context } = setup(() => reply({}));
    let probes = 0,
        sleeps = 0,
        closes = 0;
    context.ChromeDP = {
        newBrowser: async () => ({
            navigate: async () => {},
            evaluate: async () => {
                if (++probes === 1)
                    throw new Error("Execution context was destroyed.");
                return JSON.stringify({
                    title: "Comix",
                    userAgent: "Matching browser",
                });
            },
            executeCDP: async () => ({
                cookies: [
                    {
                        name: "cf_clearance",
                        value: "clearance",
                        expires: Date.now() / 1000 + 3600,
                    },
                ],
            }),
            sleep: async () => {
                sleeps++;
            },
            close: async () => {
                closes++;
            },
        }),
    };
    const session = await provider.captureSession();
    assert.equal(session.cookie, "clearance");
    assert.equal(probes, 2);
    assert.equal(sleeps, 1);
    assert.equal(closes, 1);
});
