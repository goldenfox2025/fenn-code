// Extend delimiter parsing; rewriting text nodes after parsing can pair stars
// across separate bold phrases when punctuation touches Chinese text.
export { default as remarkCjkEmphasis } from 'remark-cjk-friendly';
