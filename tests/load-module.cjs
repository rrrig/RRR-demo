const fs=require('node:fs');const path=require('node:path');
const sources=new Map();
function moduleURL(file,visiting=new Set()){file=path.resolve(file);if(sources.has(file))return sources.get(file);if(visiting.has(file))throw Error('Cyclic test module import: '+file);visiting.add(file);let source=fs.readFileSync(file,'utf8');source=source.replace(/(\bfrom\s+|\bimport\s*)['"](\.[^'"]+)['"]/g,(whole,prefix,relative)=>prefix+JSON.stringify(moduleURL(path.resolve(path.dirname(file),relative.split('?')[0]),visiting)));visiting.delete(file);source+='\n//# sourceURL='+path.basename(file);const url='data:text/javascript;base64,'+Buffer.from(source).toString('base64');sources.set(file,url);return url}
module.exports={loadESModule:file=>import(moduleURL(file)),moduleURL};
