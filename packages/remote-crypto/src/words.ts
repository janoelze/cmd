// Fingerprint words: four words from the handshake hash, shown on the Mac and
// on the phone while pairing, so a second device that grabbed the QR is caught.

import type { Bytes } from "./noise.ts";

/** 256 distinct words, one per byte value. Changing the list changes every fingerprint. */
export const WORDS: readonly string[] = [
  "acorn", "adobe", "agile", "alarm", "album", "alley", "amber", "anchor", "angle", "apple", "apron",
  "arena", "armor", "arrow", "aspen", "atlas", "attic", "autumn", "avocado", "badge", "bagel", "baker",
  "bamboo", "banjo", "barley", "basil", "basin", "beacon", "beaver", "berry", "bison", "blade", "blanket",
  "bloom", "bobcat", "bonsai", "boulder", "bramble", "breeze", "brick", "bridge", "bronze", "brook",
  "bucket", "buffalo", "bugle", "bunny", "butter", "cabin", "cactus", "camel", "canoe", "canyon", "carbon",
  "cargo", "carrot", "castle", "cedar", "cello", "chalk", "cherry", "chess", "cider", "cinder", "circus",
  "citrus", "clover", "cobalt", "cocoa", "comet", "copper", "coral", "cotton", "cougar", "coyote", "crane",
  "crater", "cricket", "crystal", "cupcake", "cypress", "daisy", "delta", "denim", "desert", "dingo",
  "dolphin", "domino", "dragon", "drum", "dune", "eagle", "easel", "ebony", "echo", "elbow", "ember",
  "emerald", "falcon", "feather", "fern", "ferry", "fiddle", "fig", "flame", "flannel", "flint", "forest",
  "fossil", "fox", "frost", "galaxy", "garnet", "gecko", "geyser", "ginger", "glacier", "globe", "goblet",
  "granite", "grape", "gravel", "guitar", "gull", "hammock", "harbor", "harp", "hazel", "heron", "hickory",
  "honey", "hornet", "husky", "igloo", "indigo", "iris", "ivory", "jacket", "jade", "jaguar", "jasmine",
  "jelly", "jigsaw", "juniper", "kayak", "kettle", "kiwi", "koala", "ladder", "lagoon", "lantern", "larch",
  "lemon", "lilac", "lily", "linen", "lizard", "lobster", "lotus", "lunar", "magnet", "mango", "maple",
  "marble", "meadow", "melon", "mesa", "mint", "mirror", "mitten", "mocha", "monsoon", "moose", "mosaic",
  "moth", "muffin", "nectar", "needle", "nickel", "noodle", "nutmeg", "oasis", "oatmeal", "ocean", "olive",
  "onyx", "orbit", "orchid", "otter", "oyster", "paddle", "panda", "papaya", "parrot", "peach", "pebble",
  "pecan", "pepper", "piano", "pickle", "pigeon", "pillow", "pine", "planet", "plum", "pocket", "polar",
  "poppy", "prairie", "prism", "pumpkin", "quail", "quartz", "quill", "rabbit", "radar", "radish", "raven",
  "reef", "ribbon", "river", "robin", "rocket", "saddle", "saffron", "salmon", "sandal", "sapphire", "satin",
  "scarf", "seal", "sequoia", "shadow", "shell", "sierra", "silver", "sketch", "sloth", "snow", "sonnet",
  "sparrow", "spruce", "squid", "stone", "sunset", "swan", "tango", "teapot", "thistle", "thunder", "tiger",
  "timber", "toast", "topaz", "tulip", "tundra",
];

export function fingerprint(hash: Bytes, n = 4): string[] {
  return [...hash.slice(0, n)].map((b) => WORDS[b]!);
}
