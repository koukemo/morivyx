import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { servePluginStdio } from "../packages/kernel/src/plugin-stdio.js";
import { runPluginProcess } from "../packages/kernel/src/plugin-communication.js";
const root=fileURLToPath(new URL("../",import.meta.url)),core=join(root,"packages/portable-core");
const python=process.env.MORIVYX_REFERENCE_PYTHON??"python3",driver=join(root,"tools/python-plugin-stdio-driver.py"),child=join(core,"fixtures/plugin-stdio-echo.py");
const vectors=JSON.parse(await readFile(join(core,"fixtures/plugin-stdio-vectors.json"),"utf8")),templates=vectors.templates,messageTemplates=vectors.messageTemplates;
const sha=x=>createHash("sha256").update(x).digest("hex");
function run(args,input,options={}){const result=spawnSync(python,["-B",...args],{cwd:root,input,encoding:"utf8",timeout:60_000,maxBuffer:4*1024*1024,...options});assert.ifError(result.error);return result;}
const pythonExecutable=run(["-c","import sys;print(sys.executable)"],"").stdout.trim();
function edited(value,edits){for(const e of edits){if(!e.path.length){value=structuredClone(e.value);continue;}let o=value;for(const k of e.path.slice(0,-1))o=o[k];if(e.delete)delete o[e.path.at(-1)];else o[e.path.at(-1)]=structuredClone(e.value);}return value;}
function values(entry){let value=structuredClone(templates);if(entry.messageSpec)value=edited(structuredClone(messageTemplates[entry.messageSpec.template]),entry.messageSpec.edits);let input=entry.inputText!==undefined?Buffer.from(entry.inputText):entry.inputBase64!==undefined?Buffer.from(entry.inputBase64,'base64'):entry.inputLength?Buffer.alloc(entry.inputLength,entry.repeatByte):null;
 if(entry.inputDepth){let x=0;for(let i=0;i<entry.inputDepth;i++)x=[x];value.request.input={deep:x};}
 if(input===null)input=Buffer.from((entry.padding??'')+(JSON.stringify(value.request)??'undefined')+'\n'+(entry.padding??''));return {request:value.request,result:value.result,input};}
async function assess(entry){const {request,result,input}=values(entry),calls=[],out=[],err=[];let mutable=structuredClone(result);
 const config={handleRequest:async value=>{calls.push('handleRequest');if(entry.handler==='throw')throw Error('INPUT_SENTINEL');if(entry.handler==='empty')return {};if(entry.handler==='cycle'){let x=structuredClone(mutable);x.output.self=x;return x;}if(entry.handler==='mutate-input')value.runId='changed';if(entry.handler==='mutate-identity')return {...mutable,runId:'changed'};if(entry.handler==='failure'){const x={...mutable,status:'failure',failure:{code:'EXAMPLE_FAILURE',message:'synthetic failure'}};delete x.output;return x;}if(entry.handler==='unicode')return {...mutable,output:{text:'e\u0301 / 日本語 / 2024-01-01T00:00:00+00:00'}};if(entry.handler==='large-output')return {...mutable,output:{text:'x'.repeat(1048576)}};if(entry.handler==='deep-output'){let x=0;for(let i=0;i<600;i++)x=[x];return {...mutable,output:{deep:x}};}return mutable;},
 validateRequest:async value=>{calls.push('validateRequest');return callback(entry.validateRequest,value);},validateResult:async(value,sent)=>{calls.push('validateResult');if(entry.validateResult==='mutate-external')mutable.runId='changed';if(entry.validateResult==='mutate')sent.runId='changed';return callback(entry.validateResult,value);},...entry.limits};
 function callback(mode,value){if(mode==='false')return false;if(mode==='throw')throw Error('INPUT_SENTINEL');if(mode==='zero')return 0;if(mode==='null')return null;if(mode==='empty-string')return '';if(mode==='mutate')value.runId='changed';}
 if(entry.badCallback)config[entry.badCallback]=null;
 let stdin=Readable.from(entry.chunkSize?Array.from(input,x=>Buffer.from([x])):[input]);
 if(entry.readMode==='error')stdin=new Readable({read(){this.destroy(Error('INPUT_SENTINEL'));}});
 if(entry.readMode==='number')stdin=Readable.from([123]);if(entry.readMode==='object')stdin=Readable.from([{}]);
 let stdout=new Writable({write(chunk,encoding,done){if(entry.writeMode==='throw')throw Error('INPUT_SENTINEL');if(entry.writeMode==='error'){done(Error('INPUT_SENTINEL'));return;}if(entry.writeMode==='partial-failure'){out.push(Buffer.from(chunk).subarray(0,3));done(Error('INPUT_SENTINEL'));return;}out.push(Buffer.from(chunk));done();}});
 if(entry.writeMode==='closed')stdout.end();
 const stderr=new Writable({write(chunk,encoding,done){if(entry.diagnosticMode==='broken'){done(Error('INPUT_SENTINEL'));return;}err.push(Buffer.from(chunk));done();}});
 const streams={stdin,stdout,stderr};if(entry.badStream)streams[entry.badStream]={};
 const status=await servePluginStdio(config,streams),data=Buffer.concat(out);return {status,stdoutSha256:sha(data),stdoutBytes:data.length,stderr:Buffer.concat(err).toString('utf8'),calls};}
test("frozen stdio cases retain their reference version, source hashes and unique names", async () => {
  assert.equal(vectors.reference.commit, "919d46ea9f2fc68ab19dd17b8019a16099de2b78");
  assert.equal(vectors.reference.node, "26.13.0");
  for (const [name, expected] of Object.entries(vectors.reference.sourceSha256)) assert.equal(sha(await readFile(join(root, "packages/kernel/src", name))), expected, name);
  assert.equal(sha(await readFile(child)), vectors.reference.childSha256);
  assert.equal(vectors.cases.length, 359); assert.equal(new Set(vectors.cases.map(entry => entry.id)).size, 359);
  assert.equal(vectors.cases.filter(entry => entry.expected.status.valid).length, 71);
});

test("359 Node and independent Python exchanges retain status, bytes, diagnostics and call order", async () => {
  const expected = vectors.cases.map(entry => entry.expected), actual = [];
  for (const entry of vectors.cases) actual.push(await assess(entry));
  assert.deepEqual(actual, expected);
  const result = run([driver, core], JSON.stringify(vectors));
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, ""); assert.deepEqual(JSON.parse(result.stdout), expected);
});

test("actual Node and independent Python hosts connect to the production Python service adapter", async () => {
  const values = JSON.parse(await readFile(join(core, "fixtures/plugin-runtime-vectors.json"), "utf8")).templates.runtime;
  const nodeResult = runPluginProcess({ ...values, command: pythonExecutable, args: ["-B", child] });
  assert.equal(nodeResult.status, "success"); assert.deepEqual(nodeResult.output.value, values.request.input);
  const code = "import json,sys;sys.path.insert(0,sys.argv[1]);from plugin_runtime import run_plugin_process;v=json.load(sys.stdin);print(json.dumps(run_plugin_process(**v,command=sys.executable,args=['-B',sys.argv[2]]),ensure_ascii=False,separators=(',',':')))";
  const result = run(["-c", code, core, child], JSON.stringify(values));
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, ""); assert.deepEqual(JSON.parse(result.stdout), nodeResult);
});

test("real service errors remain fixed and use exit code 2 without a generic execution CLI", () => {
  for (const [args, input, code] of [[[], "INPUT_SENTINEL", "PLUGIN_STDIO_INPUT_INVALID"], [[], Buffer.from([255]), "PLUGIN_STDIO_INPUT_INVALID"],
    [[], "x".repeat(1048577), "PLUGIN_STDIO_INPUT_LIMIT"], [["INPUT_SENTINEL"], "{}", "PLUGIN_STDIO_CONFIG_INVALID"]]) {
    const result = run([child, ...args], input); assert.equal(result.status, 2); assert.equal(result.stdout, ""); assert.equal(result.stderr, `${code}\n`);
  }
});

test("production Python and an external driver reproduce all 359 exchanges and a real child without Node or Git", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-plugin-stdio-"));
  try {
    const runtime = join(directory, "portable-core"), empty = join(directory, "empty-path"), isolatedDriver = join(directory, "driver.py");
    await mkdir(runtime); await mkdir(empty); await mkdir(join(runtime, "fixtures"));
    const modules = (await readdir(core)).filter(name => name.endsWith(".py") && !name.startsWith("test_") &&
      !["evidence_archive.py", "evidence_restore.py", "proposal_acceptance.py", "proposal_review.py"].includes(name));
    for (const name of modules) await copyFile(join(core, name), join(runtime, name));
    const isolatedChild = join(runtime, "fixtures/plugin-stdio-echo.py"); await copyFile(child, isolatedChild); await copyFile(driver, isolatedDriver);
    const env = { ...process.env, PATH: empty, PYTHONPATH: "", PYTHONHOME: "", PYTHONNOUSERSITE: "1" };
    for (const name of ["node", "git"]) assert.equal(spawnSync(name, ["--version"], { env }).error?.code, "ENOENT");
    const result = spawnSync(pythonExecutable, ["-B", isolatedDriver, runtime], { cwd: directory, env, input: JSON.stringify(vectors),
      encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), vectors.cases.map(entry => entry.expected));
    const code = "import json,sys;sys.path.insert(0,sys.argv[1]);from plugin_runtime import run_plugin_process;v=json.load(sys.stdin);print(json.dumps(run_plugin_process(**v,command=sys.executable,args=['-B',sys.argv[2]]),separators=(',',':')))";
    const runtimeValues = JSON.parse(await readFile(join(core, "fixtures/plugin-runtime-vectors.json"), "utf8")).templates.runtime;
    const actual = spawnSync(pythonExecutable, ["-B", "-c", code, runtime, isolatedChild], { cwd: directory, env, input: JSON.stringify(runtimeValues), encoding: "utf8", timeout: 30_000 });
    assert.ifError(actual.error); assert.equal(actual.status, 0, actual.stderr); assert.equal(actual.stderr, "");
    assert.deepEqual(JSON.parse(actual.stdout).output.value, runtimeValues.request.input);
    console.info(`Production-only stdio modules: ${modules.length}; external test driver; fixed exchanges: 359; actual child: 1`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
