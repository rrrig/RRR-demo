import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const old=await readFile(new URL('../r05/cloud-transfer.js',import.meta.url),'utf8');
const cloud='https://ignis-pro-archive.major-shark-6228.chatgpt.site';
function oldHarness(){
 const nodes=Object.fromEntries(['transferCloud','cancelCloudTransfer','cloudTransferStatus'].map(id=>[id,{hidden:false,disabled:false,addEventListener(type,f){this[type]=f;}}]));
 let events={},posts=[],reads=0,ended=0,nonce='a'.repeat(36);
 const popup={postMessage(...args){posts.push(args);}};
 const store={async init(){},async createExport(){reads++;return {exportId:'frozen',snapshot:{version:8},files:[{revisionId:'r',chunkCount:1}],chunkBytes:4194304};},async readExportChunk(){return new ArrayBuffer(4);},async endExport(){ended++;}};
 const ctx=vm.createContext({store,document:{getElementById:id=>nodes[id]},window:{open(){return popup;},addEventListener(type,f){events[type]=f;}},crypto:{randomUUID:()=>nonce},setTimeout:()=>1,clearTimeout(){},ArrayBuffer});
 vm.runInContext(old.replace(/^import .*?;\n/,''),ctx);
 return {nodes,popup,posts,get reads(){return reads;},get ended(){return ended;},async message(changes={}){await events.message({origin:cloud,source:popup,data:{channel:'ignis-transfer-v1',nonce,type:'request',requestId:'req',method:'metadata'},...changes});}};
}
test('old bridge only responds to exact cloud origin, popup, session; ends frozen export',async()=>{
 const h=oldHarness();h.nodes.transferCloud.click();
 await h.message({origin:'https://evil.test'});
 await h.message({source:{}});
 await h.message({data:{channel:'ignis-transfer-v1',nonce:'wrong',type:'request',requestId:'req',method:'metadata'}});
 assert.equal(h.reads,0);assert.equal(h.posts.length,0);
 await h.message();assert.equal(h.reads,1);assert.equal(h.posts[0][0].result.snapshot.version,8);assert.equal(h.posts[0][1],cloud);
 await h.message({data:{channel:'ignis-transfer-v1',nonce:'a'.repeat(36),type:'request',requestId:'chunk',method:'chunk',revisionId:'r',index:0}});
 assert.equal(h.posts[1][0].result.byteLength,4);assert.equal(h.posts[1][2].length,1);
 await h.message({data:{channel:'ignis-transfer-v1',nonce:'a'.repeat(36),type:'complete'}});
 assert.equal(h.ended,1);assert.equal(h.nodes.transferCloud.disabled,false);
});
test('old bridge refuses out-of-range chunks without exposing bytes',async()=>{
 const h=oldHarness();h.nodes.transferCloud.click();await h.message();
 await h.message({data:{channel:'ignis-transfer-v1',nonce:'a'.repeat(36),type:'request',requestId:'bad',method:'chunk',revisionId:'r',index:1}});
 assert.ok(h.posts[1][0].error);assert.equal(h.posts[1][0].result,undefined);
});
