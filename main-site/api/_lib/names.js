// Leaderboard display names. All validation is here, server side.

import { HttpError } from "./http.js";

const MAX_LENGTH = 20;

// Letters in any script (CJK included), with at most two combining marks
// each so Tamil and other Indic names work but stacked marks do not; digits,
// spaces, hyphens and underscores.
const ALLOWED = /^(?:[\p{L}\p{N}]\p{M}{0,2}|[ _-])+$/u;

// Matched anywhere in the squashed name. Long or unambiguous only, so an
// ordinary word does not trip it.
const ANYWHERE = [
  "fuck", "fck", "shit", "cunt", "bitch", "nigger", "nigga", "faggot", "asshole", "bastard",
  "wanker", "whore", "pussy", "penis", "vagina", "porn", "retard", "twat", "dildo", "blowjob",
  "motherf", "hitler", "cocksuck", "jerkoff",
  // Singlish, Hokkien and Malay.
  "lanjiao", "lanjio", "chibai", "cheebye", "cheebai", "pukimak", "kanina", "kannina", "nabeh",
  "knnbccb",
  // Chinese.
  "操你", "肏", "屄", "屌", "妈的", "他妈", "傻逼", "傻屄", "煞笔", "贱人", "婊子", "鸡巴", "狗日",
  "草泥马", "王八蛋", "日你", "干你", "你妈", "去死", "滚蛋", "强奸",
];

// Matched only as a whole word, since each is also part of harmless words:
// "assist", "cocktail", "grape", "Dickson", "therapist", "torpedo".
const WHOLE_WORD = new Set([
  "ass", "cock", "dick", "rape", "rapist", "fag", "slut", "tits", "cum", "sex", "nazi", "pedo",
  "knn", "ccb", "cb", "puki", "kkb", "wtf", "stfu",
]);

const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", 9: "g" };
const unleet = (s) => s.replace(/[0-9]/g, (d) => LEET[d] ?? d);

export function profane(name) {
  const lower = name.toLowerCase();
  const squashed = unleet(lower.replace(/[\s_-]+/g, ""));
  if (ANYWHERE.some((w) => squashed.includes(w))) return true;
  const words = lower.split(/[\s_-]+/).map(unleet);
  return words.some((w) => WHOLE_WORD.has(w));
}

// Trimmed, whitespace collapsed, cut to 20 characters, then checked.
export function cleanName(value) {
  let name = typeof value === "string" ? value.normalize("NFKC") : "";
  name = name.replace(/\s+/gu, " ").trim();
  name = Array.from(name).slice(0, MAX_LENGTH).join("").trim();

  if (!name) throw new HttpError(400, "empty_name", "Enter a name.");
  if (!ALLOWED.test(name) || !/[\p{L}\p{N}]/u.test(name)) {
    throw new HttpError(400, "bad_name", "Use letters, numbers, spaces, hyphens and underscores only.");
  }
  if (profane(name)) throw new HttpError(400, "rude_name", "Pick a different name.");
  return name;
}
