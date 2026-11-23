// The note's length as people count it: characters as they appear (an emoji
// with modifiers, or a letter with combining marks, is one), without line breaks.
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function countCharacters(text: string): number {
  let n = 0;
  for (const { segment } of graphemes.segment(text)) if (segment !== "\n" && segment !== "\r\n") n++;
  return n;
}
