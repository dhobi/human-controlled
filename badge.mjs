#!/usr/bin/env node
// The tool's --json result as a shields.io endpoint badge:
//
//   node human-controlled.mjs owner/repo --json | node badge.mjs > badge.json
//
// https://shields.io/badges/endpoint-badge

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function badge(result) {
  const grey = (message) => ({ schemaVersion: 1, label: "human-controlled", message, color: "lightgrey" });
  if (!result) return grey("unavailable");
  if (result.tooLittle) return grey("no score yet");
  if (result.mirror) return grey("mirror, no score");
  const score = Math.round(result.total * 100);
  return {
    schemaVersion: 1,
    // a ban is the repository's word, so its score is for the safeguards alone
    label: result.aiBan ? "safeguards" : "human-controlled",
    message: `${score}%`,
    color: score >= 75 ? "green" : score >= 50 ? "yellow" : "orange",
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let result = null;
  try { result = JSON.parse(readFileSync(0, "utf8")); } catch {}
  console.log(JSON.stringify(badge(result)));
}
