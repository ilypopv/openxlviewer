const fs=require('fs'),path=require('path'),vm=require('vm'),Module=require('module');
const R=path.resolve(__dirname,'../..');
const ts=require(R+'/node_modules/typescript');
globalThis.fflate=require(R+'/out/vendor/fflate.js');
const OX=require(R+'/out/core/csv-parser.js');require(R+'/out/core/csv-provider.js');
const {URI}=require(R+'/node_modules/vscode-uri');
// ---- fake vscode
class Position{constructor(l,c){this.line=l;this.character=c}}
class Range{constructor(a,b,c,d){if(typeof a==='number'){this.start=new Position(a,b);this.end=new Position(c,d)}else{this.start=a;this.end=b}}}
class WorkspaceEdit{constructor(){this.ops=[]}
 replace(uri,range,text){this.ops.push({range,text})}
 insert(uri,pos,text){this.ops.push({range:new Range(pos,pos),text})}}
const EndOfLine={LF:1,CRLF:2};
class FakeDoc{
 constructor(uri,text,eol){this.version=1;this.uri=uri;this.text=text;this.eol=eol||EndOfLine.LF;this.languageId='csv'}
 get lines(){return this.text.split(/\r\n|\n|\r/)}
 get lineCount(){return this.lines.length}
 getText(r){if(!r)return this.text;const a=this.offsetAt(r.start),b=this.offsetAt(r.end);return this.text.slice(a,b)}
 lineAt(i){const ls=this.lines;if(i<0||i>=ls.length)throw new Error('Illegal value for line');const t=ls[i];return{text:t,range:new Range(i,0,i,t.length)}}
 validatePos(p){const ls=this.lines;let l=p.line,c=p.character;if(l<0){return new Position(0,0)}if(l>=ls.length){return new Position(ls.length-1,ls[ls.length-1].length)}c=Math.max(0,Math.min(c,ls[l].length));return new Position(l,c)}
 validateRange(r){return new Range(this.validatePos(r.start),this.validatePos(r.end))}
 offsetAt(p){const t=this.text;let off=0,l=0;const re=/\r\n|\n|\r/g;let m;let starts=[0];while((m=re.exec(t)))starts.push(m.index+m[0].length);const ls=this.lines;return starts[p.line]+p.character}
 apply(ops){ // VS Code semantics: validate ranges, error on overlap, same-pos in order
  const o=ops.map((op,i)=>{const r=this.validateRange(op.range);return{s:this.offsetAt(r.start),e:this.offsetAt(r.end),t:op.text,i}});
  o.sort((a,b)=>a.s-b.s||a.i-b.i);
  for(let k=1;k<o.length;k++)if(o[k].s<o[k-1].e)throw new Error('Overlapping ranges are not allowed!');
  let out='',pos=0;for(const x of o){out+=this.text.slice(pos,x.s)+x.t;pos=x.e}out+=this.text.slice(pos);this.text=out;this.version++;}
}
let currentDoc=null,docListeners=[],cfg={};
const vscode={Range,Position,WorkspaceEdit,EndOfLine,ViewColumn:{One:1},
 window:{createWebviewPanel(){throw 0},showErrorMessage(){},showInformationMessage(){},activeTextEditor:null},
 workspace:{getConfiguration:()=>({get:k=>cfg[k]}),textDocuments:[],
  onDidChangeTextDocument(fn,thisArg,disp){docListeners.push(fn.bind(thisArg));return{dispose(){}}},
  async applyEdit(we){ if(vscode._delay)await new Promise(r=>setTimeout(r,vscode._delay)); if(vscode._hook)vscode._hook(); currentDoc.apply(we.ops);for(const f of docListeners)f({document:currentDoc,contentChanges:[{}]});if(vscode._after){const a=vscode._after;vscode._after=null;a()}return true},
  async openTextDocument(){return currentDoc}}};
const orig=Module._load;
Module._load=function(req,...a){if(req==='vscode')return vscode;return orig.call(this,req,...a)};
if(!require.extensions['.ts'])require.extensions['.ts']=(m,f)=>{m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:'commonjs',target:'es2019'}}).outputText,f)};
const CsvDocumentView=require(R+'/src/csvDocumentView.ts').default;
// ---- webview side
function makeWebview(text,eol,optsOver){
 currentDoc=new FakeDoc(URI.parse('file:///t.csv'),text,eol);docListeners=[];
 cfg={separator:',',quoteMark:'"',hasHeaders:true,capitalizeHeaders:false,resizeColumns:'none',lineNumbers:'none',commentCharacter:'#',skipComments:false,formatValues:'never',numberFormat:'',...(optsOver||{})};
 const hostHandlers=[];const posted=[];
 const webview={cspSource:'csp',asWebviewUri:u=>u,onDidReceiveMessage(fn,t){hostHandlers.push(fn.bind(t));return{dispose(){}}},postMessage(m){posted.push(m);setImmediate(()=>deliver(m));return Promise.resolve(true)},set html(h){}, get html(){return''}};
 const panel={webview,onDidDispose(){},visible:true};
 const view=new CsvDocumentView({extensionUri:URI.parse('file:///ext'),workspaceState:{get:()=>null,update(){}}},currentDoc.uri);
 view.languageId='csv';view.panel=panel;view.initialize();view.enableEditing(currentDoc);
 // sandbox
 let msgL=[];const ctx={console,performance,setTimeout,TextEncoder,TextDecoder,
  window:{addEventListener(n,f){if(n==='message')msgL.push(f)}},
  acquireVsCodeApi:()=>({postMessage(m){for(const h of hostHandlers)h(m)},getState:()=>null,setState(){}}),
  document:{getElementById:()=>({}),createElement:()=>({addEventListener(){},style:{},}),},
 };
 function deliver(m){for(const f of msgL)f({data:m})}
 const shellObj={};
 ctx.OX=Object.assign(Object.create(null),OX);
 class Grid{constructor(){this.h={}}on(n,f){this.h[n]=f}invalidate(){}refresh(){}select(){}scrollTo(){}getSelection(){return{ranges:[]}}}
 ctx.OX.Shell=class{constructor(app,o){this.o=o;this.grid=new Grid();this.bar={insertBefore(){}};this.btnClear={};shellObj.shell=this}
  setProvider(p){this.provider=p}applyViewState(){}getViewState(){return null}setMessage(){}_updateAll(){}isDark(){return false}clearView(){}};
 ctx.document.createElement=()=>({addEventListener(){},style:{}});
 const vctx=vm.createContext(ctx);ctx.globalThis=ctx;
 vm.runInContext(fs.readFileSync(R+'/out/csv.js','utf8')+'\nthis.initPage=initPage;this.handleEvents=handleEvents;',vctx);
 vctx.getOptions=()=>view.getOptions();vctx.ignoreState=()=>false;
 vm.runInContext('handleEvents();initPage();',vctx);
 return{view,vctx,shell:()=>shellObj.shell,doc:currentDoc,
  provider:()=>vctx.window.oxCsv&&vm.runInContext('window.oxCsv',vctx)};
}
module.exports={fire:()=>{for(const f of docListeners)f({document:currentDoc,contentChanges:[{}]})},externalEdit:(text)=>{currentDoc.text=text;currentDoc.version++;for(const f of docListeners)f({document:currentDoc,contentChanges:[{}]})},makeWebview,OX,FakeDoc,vscode,EndOfLine};
