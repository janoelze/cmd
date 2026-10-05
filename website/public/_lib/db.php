<?php
// The usage stats store: SQLite in the data dir, outside the docroot
// (~/cmd-website-data; $CMD_WEBSITE_DATA elsewhere). Batches from
// the app (packages/core/src/usage.ts) are folded into daily rows as they
// arrive: which installs were active on a day (with their version, macOS and
// arch) and how often each counter fired for each install that day, so the
// page can say what share of installs used something, and crash rates per
// version. No raw batches and no IPs are kept; install ids are stored hashed.
// Only totals are ever shown.
//
// Against spam, since anyone can post here: release builds sign batches with a
// key of their version (verify_signature), each sender (an IP, as a hash with
// a salt that changes every day) gets a few installs a day and a few batches a
// minute (rate_limit), and one install can add only so much to a counter in a
// day (daily_cap). None of this proves a batch came from cmd, whose key is in
// the app; it keeps one sender from skewing the totals much.

declare(strict_types=1);

const WINDOW_KINDS = ['terminal', 'browser', 'files', 'text', 'markdown', 'magic', 'other'];
const AGENT_KINDS = ['claude', 'codex', 'gemini', 'opencode', 'qwen', 'copilot', 'other'];
/** CrashProcess in packages/protocol/src/log.ts. */
const CRASH_PROCESSES = ['core', 'ptyhost', 'main', 'renderer', 'gpu', 'utility', 'native'];
/** Versions from before signing (≤ this) may send unsigned until UNSIGNED_UNTIL (UTC day). */
const LAST_UNSIGNED = '0.10.1';
const UNSIGNED_UNTIL = '2026-10-19';
/** Installs one sender may report in a day (one person, a household, an office behind one IP). */
const IDS_PER_SENDER_PER_DAY = 10;
/** Batches one sender may send in a minute (an app sends one). */
const BATCHES_PER_SENDER_PER_MINUTE = 20;

function data_dir(): string
{
    return getenv('CMD_WEBSITE_DATA') ?: posix_getpwuid(posix_geteuid())['dir'] . '/cmd-website-data';
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
        day TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, n INTEGER NOT NULL,
        PRIMARY KEY (day, id, name))');
    $pdo->exec('CREATE INDEX IF NOT EXISTS counts_name ON counts (name, day)');
    // Rate limiting, today's rows only (rate_limit).
    $pdo->exec('CREATE TABLE IF NOT EXISTS rate_salt (day TEXT PRIMARY KEY, salt TEXT NOT NULL)');
    $pdo->exec('CREATE TABLE IF NOT EXISTS rate_ids (day TEXT NOT NULL, sender TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (day, sender, id))');
    $pdo->exec('CREATE TABLE IF NOT EXISTS rate_batches (minute INTEGER NOT NULL, sender TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (minute, sender))');
    return $pdo;
}

/** The counter names the server accepts: anything else is dropped, so nothing else can reach the public page. */
function allowed_names(): array
{
    $names = ['app.launch', 'error'];
    foreach (CRASH_PROCESSES as $p) $names[] = "crash.$p";
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

/** The secret release keys are derived from (`usage-secret` in the data dir); null: signatures aren't checked (local testing). */
function usage_secret(): ?string
{
    $f = data_dir() . '/usage-secret';
    $s = is_file($f) ? trim((string) file_get_contents($f)) : '';
    return $s === '' ? null : $s;
}

/**
 * Whether a batch may be recorded: signed with the key of the version it claims
 * (as electron.vite.config.ts derives it), or unsigned from a version before
 * signing, for a while.
 */
function verify_signature(string $body, mixed $version, ?string $signature, string $day): bool
{
    $secret = usage_secret();
    if ($secret === null) return true;
    if (!is_string($version)) return false;
    if ($signature === null || $signature === '') {
        return $day <= UNSIGNED_UNTIL && !str_contains($version, '-') && preg_match('/^\d+\.\d+\.\d+$/', $version)
            && version_compare($version, LAST_UNSIGNED, '<=');
    }
    $key = hash_hmac('sha256', "cmd-usage:$version", $secret);
    return hash_equals(hash_hmac('sha256', $body, $key), strtolower($signature));
}

/** The sender as a hash of its IPv4 address or IPv6 /64, with a salt of the day: the same sender today, unrecognisable tomorrow. */
function sender_hash(string $ip, string $day): string
{
    $pdo = db();
    $pdo->prepare('INSERT OR IGNORE INTO rate_salt (day, salt) VALUES (?, ?)')->execute([$day, bin2hex(random_bytes(16))]);
    $st = $pdo->prepare('SELECT salt FROM rate_salt WHERE day = ?');
    $st->execute([$day]);
    $bin = @inet_pton($ip);
    $net = $bin === false ? $ip : (strlen($bin) === 16 ? substr($bin, 0, 8) : $bin);
    return substr(hash_hmac('sha256', $net, (string) $st->fetchColumn()), 0, 24);
}

/** Null when the sender may send this batch, else seconds to wait (Retry-After). Forgets everything from before today. */
function rate_limit(string $ip, string $id, int $now): ?int
{
    $pdo = db();
    $day = gmdate('Y-m-d', $now);
    $minute = intdiv($now, 60);
    $pdo->prepare('DELETE FROM rate_salt WHERE day < ?')->execute([$day]);
    $pdo->prepare('DELETE FROM rate_ids WHERE day < ?')->execute([$day]);
    $pdo->prepare('DELETE FROM rate_batches WHERE minute < ?')->execute([$minute]);
    $sender = sender_hash($ip, $day);

    $pdo->prepare('INSERT INTO rate_batches (minute, sender, n) VALUES (?, ?, 1) ON CONFLICT (minute, sender) DO UPDATE SET n = n + 1')->execute([$minute, $sender]);
    $st = $pdo->prepare('SELECT n FROM rate_batches WHERE minute = ? AND sender = ?');
    $st->execute([$minute, $sender]);
    if ((int) $st->fetchColumn() > BATCHES_PER_SENDER_PER_MINUTE) return 60;

    $st = $pdo->prepare('SELECT 1 FROM rate_ids WHERE day = ? AND sender = ? AND id = ?');
    $st->execute([$day, $sender, $id]);
    if ($st->fetchColumn()) return null;
    $st = $pdo->prepare('SELECT COUNT(*) FROM rate_ids WHERE day = ? AND sender = ?');
    $st->execute([$day, $sender]);
    if ((int) $st->fetchColumn() >= IDS_PER_SENDER_PER_DAY) return 86400 - $now % 86400; // until the next UTC day
    $pdo->prepare('INSERT INTO rate_ids (day, sender, id) VALUES (?, ?, ?)')->execute([$day, $sender, $id]);
    return null;
}

/** The most one install can add to a counter in a day, so one sender can't skew a total much. */
function daily_cap(string $name): int
{
    return match (true) {
        $name === 'app.launch' => 50,
        $name === 'error' => 200,
        str_starts_with($name, 'crash.') => 50,
        str_starts_with($name, 'agent.') => 300,
        default => 500, // windows
    };
}

function record_batch(array $b, string $day): void
{
    $pdo = db();
    $pdo->beginTransaction();
    try {
        $pdo->prepare('INSERT INTO installs (day, id, version, os, arch) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (day, id) DO UPDATE SET version = excluded.version, os = excluded.os, arch = excluded.arch')
            ->execute([$day, $b['id'], $b['version'], $b['os'], $b['arch']]);
        $add = $pdo->prepare('INSERT INTO counts (day, id, name, n) VALUES (?, ?, ?, ?)
            ON CONFLICT (day, id, name) DO UPDATE SET n = MIN(n + excluded.n, CAST(? AS INTEGER))');
        foreach ($b['counts'] as $name => $n) {
            $cap = daily_cap($name);
            $add->execute([$day, $b['id'], $name, min($n, $cap), $cap]);
        }
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
    for ($t = strtotime("$from UTC"); ($d = gmdate('Y-m-d', $t)) <= $today; $t += 86400) $daily[$d] = 0;
    foreach ($q('SELECT day, COUNT(*) AS n FROM installs WHERE day >= ? GROUP BY day', [$from]) as $r) $daily[$r['day']] = (int) $r['n'];

    $pairs = fn(array $rows) => array_column(array_map(fn($r) => [$r['k'], (int) $r['n']], $rows), 1, 0);
    $counts = $pairs($q('SELECT name AS k, SUM(n) AS n FROM counts WHERE day >= ? GROUP BY name ORDER BY n DESC', [$from]));
    $users = $pairs($q('SELECT name AS k, COUNT(DISTINCT id) AS n FROM counts WHERE day >= ? GROUP BY name', [$from]));
    $active30 = $scalar('SELECT COUNT(DISTINCT id) AS n FROM installs WHERE day >= ?', [$from]);
    // {kind: {count, installs, share}} for the names under a prefix.
    $prefixed = function (string $prefix) use ($counts, $users, $active30): array {
        $out = [];
        foreach ($counts as $k => $n) {
            if (!str_starts_with($k, $prefix)) continue;
            $u = $users[$k] ?? 0;
            $out[substr($k, strlen($prefix))] = ['count' => $n, 'installs' => $u, 'share' => $active30 ? round($u / $active30, 3) : 0];
        }
        return $out;
    };
    // Per version: launches, crashes (any process) and errors, by the version the install ran that day.
    $health = $q("SELECT i.version AS version,
            COUNT(DISTINCT i.id) AS installs,
            COALESCE(SUM(CASE WHEN c.name = 'app.launch' THEN c.n END), 0) AS launches,
            COALESCE(SUM(CASE WHEN c.name LIKE 'crash.%' THEN c.n END), 0) AS crashes,
            COUNT(DISTINCT CASE WHEN c.name LIKE 'crash.%' THEN i.id END) AS crashedInstalls,
            COALESCE(SUM(CASE WHEN c.name = 'error' THEN c.n END), 0) AS errors
        FROM installs i LEFT JOIN counts c ON c.day = i.day AND c.id = i.id
        WHERE i.day >= ? GROUP BY i.version", [$from]);
    foreach ($health as &$r) {
        foreach (['installs', 'launches', 'crashes', 'crashedInstalls', 'errors'] as $k) $r[$k] = (int) $r[$k];
    }
    unset($r);
    usort($health, fn($a, $b) => version_compare($b['version'], $a['version']));
    // An install's latest version/macOS/arch in the window.
    $latest = 'SELECT i.%1$s AS k, COUNT(*) AS n FROM installs i
        JOIN (SELECT id, MAX(day) AS day FROM installs WHERE day >= ? GROUP BY id) l ON l.id = i.id AND l.day = i.day
        GROUP BY i.%1$s ORDER BY n DESC';

    return [
        'from' => $from,
        'to' => $today,
        'activeToday' => $daily[$today] ?? 0,
        'active7' => $scalar('SELECT COUNT(DISTINCT id) AS n FROM installs WHERE day >= ?', [$week]),
        'active30' => $active30,
        'installs' => $scalar('SELECT COUNT(DISTINCT id) AS n FROM installs'),
        'launches' => $counts['app.launch'] ?? 0,
        'daily' => $daily,
        'versions' => $pairs($q(sprintf($latest, 'version'), [$week])),
        'macos' => $pairs($q(sprintf($latest, 'os'), [$from])),
        'arch' => $pairs($q(sprintf($latest, 'arch'), [$from])),
        'windows' => $prefixed('window.'),
        'agents' => $prefixed('agent.'),
        'crashes' => $prefixed('crash.'),
        'health' => $health,
    ];
}
