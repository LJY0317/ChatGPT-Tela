import {runInNewContext} from 'node:vm';
import {describe, expect, test} from 'bun:test';
import {assistantBody} from './answer-body';
import {assistantMarkdown} from './answer-markdown';
class Text {nodeType=3;constructor(readonly textContent:string){}}
class Element {nodeType=1;hidden=false;classList:string[]=[];namespaceURI="http://www.w3.org/1999/xhtml";get attributes(){return Object.entries(this.attrs).map(([localName,textContent])=>({localName,textContent,namespaceURI:null}));}readonly tagName:string;constructor(tag:string,readonly childNodes:Array<Text|Element>=[],readonly attrs:Record<string,string>={}){this.tagName=tag.toUpperCase();}get children(){return this.childNodes.filter((n):n is Element=>n instanceof Element);}get textContent():string{return this.childNodes.map(n=>n.textContent).join('');}getAttribute(k:string){return this.attrs[k]??null;}querySelectorAll(tag:string):Element[]{return this.children.flatMap(c=>[...(c.tagName.toLowerCase()===tag?[c]:[]),...c.querySelectorAll(tag)]);}querySelector(tag:string){return this.querySelectorAll(tag)[0]??null;}}
const t=(s:string)=>new Text(s),n=(tag:string,...children:Array<Text|Element>)=>new Element(tag,children);
function evaluate(fn:Function,root:Element){return runInNewContext(`(${fn.toString()})(root)`,{root,HTMLElement:Element,URL,document:{baseURI:'https://example.com/'},getComputedStyle:()=>({display:'block',visibility:'visible'})});}
const body=(root:Element)=>evaluate(assistantBody,root);
describe('owned author structure',()=>{
 test('layout wrapper drift changes Markdown but preserves author proof',()=>{
  const a=n('div',n('p',t('First')),n('p',t('Second'))),b=n('div',n('section',n('div',n('p',t('First')))),n('p',t('Second')));
  expect(evaluate(assistantMarkdown,a)).not.toBe(evaluate(assistantMarkdown,b));expect(body(a)).toEqual(body(b));expect(body(a).value).toBeDefined();
 });
 test('split text and inline wrapper nodes do not change author proof',()=>{expect(body(n('div',n('p',t('exact text'))))).toEqual(body(n('div',n('p',n('span',t('exact ')),t('text')))));});
 test.each([
  [n('p',t('A')),n('p',t('B'))],
  [n('div',n('p',t('A')),n('p',t('B'))),n('p',t('AB'))],
  [n('pre',n('code',t('a b'))),n('pre',n('code',t('a  b')))],
  [n('p',n('strong',t('A'))),n('p',t('A'))],
  [n('ul',n('li',t('A')),n('li',t('B'))),n('ul',n('li',t('B')),n('li',t('A')))],
  [new Element('ol',[n('li',t('A'))],{start:'1'}),new Element('ol',[n('li',t('A'))],{start:'2'})],
  [new Element('a',[t('A')],{href:'/one'}),new Element('a',[t('A')],{href:'/two'})],
  [n('table',n('tr',n('td',t('A')))),n('table',n('tr',n('td',t('B'))))],
 ])('meaningful author change is not equal (%#)',(a,b)=>{const x=body(n('div',a)),y=body(n('div',b));expect(x.value).toBeDefined();expect(y.value).toBeDefined();expect(x.value).not.toBe(y.value);});
 test('format aliases preserve semantic marks',()=>{expect(body(n('div',n('p',n('b',t('A')),n('i',t('B')))))).toEqual(body(n('div',n('p',n('strong',t('A')),n('em',t('B'))))));});
 test('presentation visibility does not remove known author content; controls excluded',()=>{const a=n('div',n('p',t('A'))),b=n('div',n('p',t('A')),n('button',t('Copy')));b.children[0]!.hidden=true;expect(body(a)).toEqual(body(b));});
 test.each(['math','img','custom-author-node'])('author element %s has a structural proof without a tag-specific exception',(tag)=>{
  const root=n('div',n(tag,t('A')));expect(body(root).value).toBeDefined();
  expect(body(root)).not.toEqual(body(n('div',n(tag,t('B')))));
  expect(body(root)).not.toEqual(body(n('div',t('A'))));
 });
 test('generic attributes are order-independent and preserve non-text author meaning',()=>{
  const image=(attrs:Record<string,string>)=>n('div',new Element('img',[],attrs));
  expect(body(image({src:'/one',alt:'A'}))).toEqual(body(image({alt:'A',src:'/one'})));
  expect(body(image({src:'/one',alt:'A'}))).not.toEqual(body(image({src:'/two',alt:'A'})));
  expect(body(image({src:'/one',alt:'A'}))).not.toEqual(body(image({src:'/one',alt:'B'})));
 });
 test('generic SVG and MathML do not require HTMLElement and retain namespace and geometry',()=>{
  const svg=(path:string)=>{const root=n('div');const graphic=n('svg',new Element('path',[],{d:path}));
   graphic.namespaceURI=graphic.children[0]!.namespaceURI='http://www.w3.org/2000/svg';root.childNodes.push(graphic);return root;};
  // A separate HTML constructor makes non-HTML instanceof checks fail, as in a browser.
  const evaluateForeign=(root:Element)=>runInNewContext(`(${assistantBody.toString()})(root)`,{root,HTMLElement:class {},URL,document:{baseURI:'https://example.com/'}});
  expect(evaluateForeign(svg('M0 0 L1 1')).value).toBeDefined();
  expect(evaluateForeign(svg('M0 0 L1 1'))).not.toEqual(evaluateForeign(svg('M0 0 L2 2')));
  const math=n('math',n('mi',t('x')));math.namespaceURI='http://www.w3.org/1998/Math/MathML';
  expect(evaluateForeign(n('div',math)).value).toBeDefined();
  expect(body(n('div',math))).not.toEqual(body(n('div',n('math',n('mi',t('x'))))));
 });
 test('generic attributes share the existing body budget',()=>{
  expect(body(n('div',new Element('custom-author-node',[],{data:'A'.repeat(1_048_577)})))).toEqual({version:1,reason:'body_budget'});
 });
 test('unrepresentable non-element nodes remain unavailable',()=>{
  const unknown=Object.assign(new Text('PRIVATE_UNKNOWN'),{nodeType:7});
  expect(body(n('div',unknown))).toEqual({version:1,reason:'unsupported_node'});
 });
 test('empty body is unavailable rather than a committed empty answer',()=>{expect(body(n('div'))).toEqual({version:1,reason:'body_empty'});});
 test('code newline normalization preserves interior and trailing whitespace',()=>{expect(body(n('div',n('pre',n('code',t('A\r\nB\n')))))).toEqual(body(n('div',n('pre',n('code',t('A\nB\n'))))));expect(body(n('div',n('pre',n('code',t('A\nB\n')))))).not.toEqual(body(n('div',n('pre',n('code',t('A\nB'))))));});
});
