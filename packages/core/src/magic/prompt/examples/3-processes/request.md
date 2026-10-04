Request: what's eating my cpu
Notes: `ps -Ao pid,pcpu,rss,comm -r` lists processes by CPU, a header line first. data.ts parses it; the view keeps a short CPU history per process for a sparkline. Layout: the total and its sparkline at the top, the table at the bottom (k-edges).
