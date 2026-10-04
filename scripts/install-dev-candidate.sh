#!/usr/bin/env bash
# Install a checksum-pinned, dependency-free candidate only on the verified DEV container.
# Retain the package and every previous version/manifest for recovery. Restart is explicit.
set -euo pipefail
if [[ $# != 4 ]]; then
  echo "Usage: sudo $0 CONTAINER PACKAGE.tgz VERSION SHA256" >&2
  exit 2
fi
container="$1"
archive="$2"
version="$3"
checksum="$4"
[[ -f "$archive" && "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$ && "$checksum" =~ ^[0-9a-f]{64}$ ]]
[[ "$(sha256sum "$archive" | cut -d' ' -f1)" == "$checksum" ]]
docker inspect "$container" | python3 -c '
import json,sys
c=json.load(sys.stdin)[0]
env=dict(v.split("=",1) for v in c["Config"]["Env"] if "=" in v)
assert env.get("WEBHOOK_URL", "").rstrip("/") in ["https://dev.n8n.grupologali.com","https://n8n-dev.grupologali.com"], "Not a verified DEV URL"
assert c["State"]["Status"] == "running" and c["State"].get("Health",{}).get("Status") == "healthy", "DEV is not healthy"
'
python3 - "$archive" "$version" <<'PY'
import json,sys,tarfile
with tarfile.open(sys.argv[1],"r:gz") as archive:
    for member in archive.getmembers():
        assert member.name.startswith("package/") and ".." not in member.name.split("/"), "Unsafe archive path"
        assert member.isfile() or member.isdir(), "Archive links are not allowed"
    package=json.load(archive.extractfile("package/package.json"))
    assert package["name"] == "n8n-nodes-sap-odata-guard" and package["version"] == sys.argv[2], "Wrong candidate"
    assert not package.get("dependencies"), "This installer supports dependency-free candidates only"
PY
file="n8n-nodes-sap-odata-guard-${version}.tgz"
docker cp "$archive" "$container:/tmp/$file"
docker exec -u node -e CANDIDATE_FILE="$file" -e CANDIDATE_VERSION="$version" -e CANDIDATE_SHA256="$checksum" "$container" sh -eu -c '
base=/home/node/.n8n/nodes
packages=/home/node/.n8n/packages
name=n8n-nodes-sap-odata-guard
target="$base/node_modules/$name"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
stage="$packages/$name-$CANDIDATE_VERSION.stage-$stamp"
backup="$packages/$name.backup-$stamp"
test -f "$target/package.json"
test "$(sha256sum "/tmp/$CANDIDATE_FILE" | cut -d" " -f1)" = "$CANDIDATE_SHA256"
mkdir -p "$stage" "$backup"
cp "/tmp/$CANDIDATE_FILE" "$packages/$CANDIDATE_FILE"
tar -xzf "$packages/$CANDIDATE_FILE" --strip-components=1 -C "$stage"
NODE_PATH=/usr/local/lib/node_modules/n8n/node_modules STAGE="$stage" node <<"NODE"
const path=process.env.STAGE;
const pkg=require(path+"/package.json");
if(pkg.version!==process.env.CANDIDATE_VERSION) throw Error("Wrong staged version");
for(const module of [...pkg.n8n.nodes,...pkg.n8n.credentials]) require(path+"/"+module);
console.log("runtime_load_ok="+pkg.version);
NODE
BACKUP="$backup" BASE="$base" node <<"NODE"
const fs=require("fs"),crypto=require("crypto"),base=process.env.BASE,backup=process.env.BACKUP;
const file=process.env.CANDIDATE_FILE,version=process.env.CANDIDATE_VERSION,name="n8n-nodes-sap-odata-guard";
const integrity="sha512-"+crypto.createHash("sha512").update(fs.readFileSync("/home/node/.n8n/packages/"+file)).digest("base64");
const manifests=["package.json","package-lock.json","node_modules/.package-lock.json"];
const present=manifests.filter(p=>fs.existsSync(base+"/"+p));
for(const relative of present){
  const filename=relative.replaceAll("/","_");
  fs.copyFileSync(base+"/"+relative,backup+"/"+filename);
  const data=JSON.parse(fs.readFileSync(base+"/"+relative,"utf8"));
  if(relative==="package.json") data.dependencies[name]="file:../packages/"+file;
  else {
    if(data.packages?.[""]?.dependencies) data.packages[""].dependencies[name]="file:../packages/"+file;
    const entry=data.packages?.["node_modules/"+name];
    if(entry) Object.assign(entry,{version,resolved:"file:../packages/"+file,integrity});
  }
  fs.writeFileSync(backup+"/"+filename+".candidate",JSON.stringify(data,null,2)+"\n");
}
fs.writeFileSync(backup+"/manifest-list.json",JSON.stringify(present));
NODE
mv "$target" "$backup/package"
mv "$stage" "$target"
BACKUP="$backup" BASE="$base" NODE_PATH=/usr/local/lib/node_modules/n8n/node_modules node <<"NODE"
const fs=require("fs"),base=process.env.BASE,backup=process.env.BACKUP,name="n8n-nodes-sap-odata-guard";
const present=JSON.parse(fs.readFileSync(backup+"/manifest-list.json"));
try {
  const path=base+"/node_modules/"+name,pkg=require(path+"/package.json");
  for(const module of [...pkg.n8n.nodes,...pkg.n8n.credentials]) require(path+"/"+module);
  for(const relative of present) fs.copyFileSync(backup+"/"+relative.replaceAll("/","_")+".candidate",base+"/"+relative);
  fs.writeFileSync(backup+"/installation.json",JSON.stringify({package:name,version:pkg.version,sha256:process.env.CANDIDATE_SHA256,installedAt:new Date().toISOString(),previousVersion:require(backup+"/package/package.json").version},null,2)+"\n");
  console.log("installed="+pkg.version+" backup="+backup);
} catch(error) {
  fs.renameSync(base+"/node_modules/"+name,backup+"/failed-package");
  fs.renameSync(backup+"/package",base+"/node_modules/"+name);
  for(const relative of present) fs.copyFileSync(backup+"/"+relative.replaceAll("/","_"),base+"/"+relative);
  throw Error("Candidate failed; previous package/manifests restored");
}
NODE
'
echo "Candidate installed. Restart $container explicitly, then verify API, node schema, and acceptance."
