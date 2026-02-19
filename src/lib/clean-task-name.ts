const FILLER_PREFIXES = [
  "we should",
  "we need to",
  "we want to",
  "can you",
  "could you",
  "would you",
  "i want to",
  "i'd like to",
  "i would like to",
  "i need to",
  "let's",
  "let us",
  "go ahead and",
  "make sure to",
  "try to",
  "you should",
  "you need to",
  "please help me",
  "help me",
  "please",
];

const prefixPattern = new RegExp(
  `^(${FILLER_PREFIXES.map((p) => p.replace(/'/g, "['\u2019]")).join("|")})\\b\\s*`,
  "i",
);

export function cleanTaskName(text: string): string {
  let result = text.trim();

  // Strip leading filler phrases (loop to catch stacked: "please try to ...")
  let prev = "";
  while (result !== prev) {
    prev = result;
    result = result.replace(prefixPattern, "").trim();
  }

  // Strip trailing "please"
  result = result.replace(/\s+please[.!?]?$/i, "").trim();

  return result || text.trim();
}
