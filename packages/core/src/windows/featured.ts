// Window types that features declare in their own folders (kernel/features.ts): registered
// with the built-ins (builtin.ts), in this order, where the Journal always stood in the Widget Library.

import { journalType } from "../journal/feature.ts";
import { statsType } from "../stats/feature.ts";
import { operatorType } from "../operator/feature.ts";
import { nowPlayingType } from "../nowplaying/feature.ts";

export const FEATURE_TYPES = [journalType, statsType, operatorType, nowPlayingType] as const;
