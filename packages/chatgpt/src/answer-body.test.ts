import {runInNewContext} from 'node:vm';
import {describe, expect, test} from 'bun:test';
import {assistantBody} from './answer-body';
import {assistantMarkdown} from './answer-markdown';
class Text {nodeType=3;constructor(readonly textContent:string){}}
class Element {nodeType=1;hidden=false;classList:string[]=[];readonly tagName:string;constructor(tag:string,readonly childNodes:Array<Text|Element>=[],readonly attrs:Record<string,string>={}){this.tagName=tag.toUpperCase();}get children(){return this.childNodes.filter((n):n is Element=>n instanceof Element);}get textContent():string{return this.childNodes.map(n=>n.textContent).join('');}getAttribute(k:string){return this.attrs[k]??null;}querySelectorAll(tag:string):Element[]{return this.children.flatMap(c=>[...(c.tagName.toLowerCase()===tag?[c]:[]),...c.querySelectorAll(tag)]);}querySelector(tag:string){return this.querySelectorAll(tag)[0]??null;}}
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
 test.each(['math','img','custom-author-node'])('unknown meaningful %s is unavailable',(tag)=>{expect(body(n('div',n(tag,t('A'))))).toEqual({version:1,reason:'unsupported_node'});});
 test('empty body is unavailable rather than a committed empty answer',()=>{expect(body(n('div'))).toEqual({version:1,reason:'body_empty'});});
 test('code newline normalization preserves interior and trailing whitespace',()=>{expect(body(n('div',n('pre',n('code',t('A\r\nB\n')))))).toEqual(body(n('div',n('pre',n('code',t('A\nB\n'))))));expect(body(n('div',n('pre',n('code',t('A\nB\n')))))).not.toEqual(body(n('div',n('pre',n('code',t('A\nB'))))));});
});
