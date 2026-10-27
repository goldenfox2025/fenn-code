import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkCjkEmphasis } from '../src/shared/remarkCjkEmphasis';

const render = (text: string) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkCjkEmphasis], children: text }));
describe('Chinese Markdown emphasis', () => {
  it('supports punctuation-adjacent Chinese phrases and ordinary English emphasis', () => {
    expect(render('这段**「重点」**，接着说**中文**。')).toContain('<strong>「重点」</strong>');
    expect(render('这段**「重点」**，接着说**中文**。')).toContain('<strong>中文</strong>');
    expect(render('Some **important** text')).toContain('<strong>important</strong>');
  });
  it('preserves inline code, fenced code and explicitly escaped stars', () => {
    expect(render('`**中文**`')).toContain('<code>**中文**</code>');
    expect(render('```text\n**中文**\n```')).not.toContain('<strong>');
    expect(render('\\*\\*中文\\*\\*')).not.toContain('<strong>');
  });
});
