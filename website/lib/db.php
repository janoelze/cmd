<?php
// The usage stats store: SQLite in the data dir, outside the deployed tree
// (~/cmd-website-data on the server; $CMD_WEBSITE_DATA elsewhere). Batches from
// the app (packages/core/src/usage.ts) are folded into daily rows as they
// arrive: which installs were active on a day (with their version, macOS and
// arch) and how often each counter fired. No raw batches and no IPs are kept;
// install ids are stored hashed.

declare(strict_types=1);

const WINDOW_KINDS = ['terminal', 'browser', 'files', 'text', 'markdown', 'magic', 'other'];
const AGENT_KINDS = ['claude', 'codex', 'gemini', 'opencode', 'qwen', 'copilot', 'other'];

function data_dir(): string
{
    return getenv('CMD_WEBSITE_DATA') ?: dirname(__DIR__, 2) . '/cmd-website-data';
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo) return $pdo;
    $dir = data_dir();
    if (!is_dir($dir)) mkdir($dir, 0700, true);
    $pdo = new PDO('sqlite:' . $dir . '/usage.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA busy_timeout = 3000');
    $pdo->exec('CREATE TABLE IF NOT EXISTS installs (
        day TEXT NOT NULL, id TEXT NOT NULL, version TEXT NOT NULL, os TEXT NOT NULL, arch TEXT NOT NULL,
        PRIMARY KEY (day, id))');
    $pdo->exec('CREATE TABLE IF NOT EXISTS counts (
        day TEXT NOT NULL, name TEXT NOT NULL, n INTEGER NOT NULL,
        PRIMARY KEY (day, name))');
    return $pdo;
}

/** The counter names the server accepts: anything else is dropped, so nothing else can reach the public page. */
function allowed_names(): array
{
    $names = ['app.launch'];
    foreach (WINDOW_KINDS as $k) $names[] = "window.$k";
    foreach (AGENT_KINDS as $k) $names[] = "agent.$k";
    return $names;
}

/** A batch as the app sends it, or null when it isn't one. */
function parse_batch(mixed $b): ?array
{
    if (!is_array($b) || ($b['v'] ?? null) !== 1) return null;
    $id = $b['id'] ?? null;
    if (!is_string($id) || !preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $id)) return null;
    $version = is_string($b['version'] ?? null) && preg_match('/^\d{1,3}\.\d{1,3}\.\d{1,4}(-[0-9a-z.]{1,20})?$/i', $b['version']) ? $b['version'] : 'other';
    $os = is_string($b['os'] ?? null) && preg_match('/^\d{1,2}$/', $b['os']) ? $b['os'] : 'other';
    $arch = in_array($b['arch'] ?? null, ['arm64', 'x64'], true) ? $b['arch'] : 'other';
    $counts = [];
    $allowed = allowed_names();
    foreach (is_array($b['counts'] ?? null) ? $b['counts'] : [] as $name => $n) {
        if (in_array($name, $allowed, true) && is_int($n) && $n > 0) $counts[$name] = min($n, 1000);
    }
    return ['id' => substr(hash('sha256', strtolower($id)), 0, 24), 'version' => $version, 'os' => $os, 'arch' => $arch, 'counts' => $counts];
}

function record_batch(array $b, string $day): void
{
    $pdo = db();
    $pdo->beginTransaction();
    try {
        $pdo->prepare('INSERT INTO installs (day, id, version, os, arch) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (day, id) DO UPDATE SET version = excluded.version, os = excluded.os, arch = excluded.arch')
            ->execute([$day, $b['id'], $b['version'], $b['os'], $b['arch']]);
        $add = $pdo->prepare('INSERT INTO counts (day, name, n) VALUES (?, ?, ?)
            ON CONFLICT (day, name) DO UPDATE SET n = n + excluded.n');
        foreach ($b['counts'] as $name => $n) $add->execute([$day, $name, $n]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
}

/** Everything the public page shows, for the $days days up to today (UTC). */
function summary(int $days = 30): array
{
    $pdo = db();
    $today = gmdate('Y-m-d');
    $from = gmdate('Y-m-d', strtotime("-" . ($days - 1) . " days"));
    $week = gmdate('Y-m-d', strtotime('-6 days'));
    $q = function (string $sql, array $p = []) use ($pdo): array {
        $st = $pdo->prepare($sql);
        $st->execute($p);
        return $st->fetchAll(PDO::FETCH_ASSOC);
    };
    $scalar = fn(string $sql, array $p = []) => (int) ($q($sql, $p)[0]['n'] ?? 0);

    $daily = [];
    for ($t = strtotime($from); ($d = gmdate('Y-m-d', $t)) <= $today; $t += 86400) $daily[$d] = 0;
    foreach ($q('SELECT day, COUNT(*) AS n FROM installs WHERE day >= ? GROUP BY day', [$from]) as $r) $daily[$r['day']] = (int) $r['n'];

    $pairs = fn(array $rows) => array_column(array_map(fn($r) => [$r['k'], (int) $r['n']], $rows), 1, 0);
    $counts = $pairs($q('SELECT name AS k, SUM(n) AS n FROM counts WHERE day >= ? GROUP BY name ORDER BY n DESC', [$from]));
    $prefixed = function (string $prefix) use ($counts): array {
        $out = [];
        foreach ($counts as $k => $n) if (str_starts_with($k, $prefix)) $out[substr($k, strlen($prefix))] = $n;
        return $out;
    };
    // An install's latest version/macOS/arch in the window.
    $latest = 'SELECT i.%1$s AS k, COUNT(*) AS n FROM installs i
        JOIN (SELECT id, MAX(day) AS day FROM installs WHERE day >= ? GROUP BY id) l ON l.id = i.id AND l.day = i.day
        GROUP BY i.%1$s ORDER BY n DESC';

    return [
        'from' => $from,
        'to' => $today,
        'activeToday' => $daily[$today] ?? 0,
        'active7' => $scalar('SELECT COUNT(DISTINCT id) AS n FROM installs WHERE day >= ?', [$week]),
        'active30' => $scalar('SELECT COUNT(DISTINCT id) AS n FROM installs WHERE day >= ?', [$from]),
        'installs' => $scalar('SELECT COUNT(DISTINCT id) AS n FROM installs'),
        'launches' => $counts['app.launch'] ?? 0,
        'daily' => $daily,
        'versions' => $pairs($q(sprintf($latest, 'version'), [$week])),
        'macos' => $pairs($q(sprintf($latest, 'os'), [$from])),
        'arch' => $pairs($q(sprintf($latest, 'arch'), [$from])),
        'windows' => $prefixed('window.'),
        'agents' => $prefixed('agent.'),
    ];
}
