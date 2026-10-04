<?php
// cmd's GitHub releases for the product page, cached in the data dir for an
// hour (a stale copy is used when GitHub doesn't answer).

declare(strict_types=1);
require_once __DIR__ . '/db.php';

const RELEASES_URL = 'https://api.github.com/repos/janoelze/cmd/releases?per_page=30';

/** [{tag, name, date, url, dmg, prerelease}], newest first; [] when unknown. */
function releases(): array
{
    $cache = data_dir() . '/releases.json';
    $fresh = is_file($cache) && filemtime($cache) > time() - 3600;
    if (!$fresh) {
        $ctx = stream_context_create(['http' => [
            'timeout' => 4,
            'header' => "User-Agent: endtime-instruments.org/cmd\r\nAccept: application/vnd.github+json\r\n",
        ]]);
        $json = @file_get_contents(RELEASES_URL, false, $ctx);
        if ($json !== false && is_array(json_decode($json, true))) {
            if (!is_dir(data_dir())) mkdir(data_dir(), 0700, true);
            file_put_contents($cache, $json, LOCK_EX);
        } elseif (is_file($cache)) {
            touch($cache); // try again in an hour, not on every request
        }
    }
    $list = is_file($cache) ? json_decode((string) file_get_contents($cache), true) : null;
    if (!is_array($list)) return [];
    $out = [];
    foreach ($list as $r) {
        if (!empty($r['draft'])) continue;
        $dmg = null;
        foreach ($r['assets'] ?? [] as $a) {
            if (str_ends_with($a['name'] ?? '', '.dmg')) $dmg = $a['browser_download_url'];
        }
        $out[] = [
            'tag' => (string) $r['tag_name'],
            'name' => (string) ($r['name'] ?: $r['tag_name']),
            'date' => substr((string) ($r['published_at'] ?? ''), 0, 10),
            'url' => (string) $r['html_url'],
            'dmg' => $dmg,
            'prerelease' => !empty($r['prerelease']),
        ];
    }
    return $out;
}
