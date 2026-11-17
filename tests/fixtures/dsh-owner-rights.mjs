// Real installed native SDK: separate write capabilities and a read-only token.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const [entry,root,outside]=process.argv.slice(2);
const {AclSandbox,workspaceWriteSid}=await import(pathToFileURL(createRequire(entry).resolve('@deepseek-ai/dsh-sandbox-windows-acl')));
const a=join(root,'a'),b=join(root,'b');
const sandbox=(work,mode='workspace-write')=>new AclSandbox({writableDirs:mode==='read-only'?[]:[work],tempDir:null,mode,
  ...(mode==='read-only'?{}:{writeSid:workspaceWriteSid(work)})});
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const deny=(path,label)=>`try { Set-Content -LiteralPath ${quote(path)} -Value BAD -NoNewline; exit 9 } catch { `+
  `if ($_.FullyQualifiedErrorId -notlike '*UnauthorizedAccess*') { throw }; Write-Output '${label}' }`;
const execute=async(box,script)=>{
 await box.init();
 try{
  const value=await box.spawn({command:join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),
    args:['-NoProfile','-Command',"$ErrorActionPreference='Stop'; "+script],cwd:a}).wait();
  return {...value,stdout:value.stdout.toString(),stderr:value.stderr.toString()};
 }finally{box.dispose();}
};
// B has a standing Low label and its own capability, so MIC alone cannot
// explain the rejection from A. Both trees have ordinary owner projections.
const previous=sandbox(b);await previous.init();previous.dispose();
const written=await execute(sandbox(a),
 "Set-Content -LiteralPath 'inside.txt' -Value YES -NoNewline; "+
 "if ((Get-Content -LiteralPath 'inside.txt' -Raw) -ne 'YES') {exit 8}; "+
 "New-Item -ItemType Directory -Path nested | Out-Null; Set-Content -LiteralPath 'nested/child.txt' -Value CHILD -NoNewline; "+
 "if ((Get-Content -LiteralPath 'nested/child.txt' -Raw) -ne 'CHILD') {exit 8}; Write-Output INSIDE_OK; "+
 deny(join(b,'keep.txt'),'SIBLING_DENIED')+'; '+deny(outside,'OUTSIDE_DENIED')+'; '+
 "cmd.exe /d /c 'icacls inside.txt /grant \"*S-1-1-0:(F)\" >nul 2>nul'; "+
 "if ($LASTEXITCODE -ne 5) { throw 'Unexpected icacls result' }; Write-Output DAC_DENIED");
assert.equal(written.exitCode,0,JSON.stringify(written));
assert.equal(written.stderr,'');
assert.deepEqual(written.stdout.trim().split(/\r?\n/),['INSIDE_OK','SIBLING_DENIED','OUTSIDE_DENIED','DAC_DENIED']);
const readonly=await execute(sandbox(a,'read-only'),
 "if ((Get-Content -LiteralPath 'inside.txt' -Raw) -ne 'YES') {exit 8}; Write-Output READ_OK; "+
 deny(join(a,'inside.txt'),'READONLY_INSIDE_DENIED')+'; '+deny(join(b,'keep.txt'),'READONLY_SIBLING_DENIED'));
assert.equal(readonly.exitCode,0,JSON.stringify(readonly));assert.equal(readonly.stderr,'');
assert.deepEqual(readonly.stdout.trim().split(/\r?\n/),['READ_OK','READONLY_INSIDE_DENIED','READONLY_SIBLING_DENIED']);
assert.equal(readFileSync(join(a,'inside.txt'),'utf8'),'YES');
assert.equal(readFileSync(join(a,'nested/child.txt'),'utf8'),'CHILD');
assert.equal(readFileSync(join(b,'keep.txt'),'utf8'),'KEEP');
assert.equal(readFileSync(outside,'utf8'),'KEEP');
console.log(JSON.stringify({written,readonly,inside:'YES',nested:'CHILD',sibling:'KEEP',outside:'KEEP'}));
