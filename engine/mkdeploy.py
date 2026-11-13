import json
code=open('dist/worker.js').read()
DB='46ebfd9f-ac57-4a73-a246-99f2321c3a38'
js="""async () => {
const code = %s;
const metadata = { main_module: "worker.mjs", compatibility_date: "2025-09-01", bindings: [{ type: "d1", name: "DB", id: "%s" }], keep_bindings: [] };
const form = new FormData();
form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
form.append("worker.mjs", new Blob([code], { type: "application/javascript+module" }), "worker.mjs");
const up = await cloudflare.request({ method: "PUT", path: `/accounts/${accountId}/workers/scripts/pulse2-engine`, body: form });
const sch = await cloudflare.request({ method: "PUT", path: `/accounts/${accountId}/workers/scripts/pulse2-engine/schedules`, body: [{ cron: "* * * * *" }] });
const sub = await cloudflare.request({ method: "POST", path: `/accounts/${accountId}/workers/scripts/pulse2-engine/subdomain`, body: { enabled: true, previews_enabled: false } });
return { up: up.success, res: up.result && {id:up.result.id, etag:up.result.etag, modified_on:up.result.modified_on, deployment_id:up.result.deployment_id, startup_time_ms:up.result.startup_time_ms},  size: code.length, sch: sch.result, sub: sub.result };
}""" % (json.dumps(code), DB)
open('/workspace/deploy_pulse2.js','w').write(js)
print(len(js))
