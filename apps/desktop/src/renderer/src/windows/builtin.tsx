// Built-in window views. Each registers itself in its own folder (windows/<kind>/register.tsx),
// with the same registration a plugin would; this list is the order they register in.

import "./markdown/register.tsx";
import "./json/register.tsx";
import "./sqlite/register.tsx";
import "./visualizer/register.tsx";
import "./image/register.tsx";
import "./video/register.tsx";
import "./jam/register.tsx";
import "./browser/register.tsx";
import "./files/register.tsx";
import "./pdf/register.tsx";
import "./text/register.tsx";
import "./magic/register.tsx";
import "./agents/register.tsx";
import "./diff/register.tsx";
import "./youtube/register.tsx";
import "./navigator/register.tsx";
import "./commands/register.tsx";
import "./actions/register.tsx";
import "./journal/register.tsx";
import "./stats/register.tsx";
import "./operator/register.tsx";
import "./notifications/register.tsx";
import "./resources/register.tsx";
import "./events/register.tsx";
import "./timer/register.tsx";
import "./nowplaying/register.tsx";
