<?php
// POST endpoint for the app's usage batches (packages/core/src/usage.ts). Takes
// JSON, keeps only known counter names (_lib/db.php) and answers 204. The
// sender's IP is only used as a hash with a daily salt, for rate limits, and
// forgotten the next day.
//
// Answers: 400 not a batch, 401 not signed with its version's key (the app
// drops it), 429 with Retry-After for a sender over its limits (the app waits
// and keeps its counts).
//
// Switches, as files in the data dir: `pause` (its content: seconds, default
// 3600) answers 429 with Retry-After, so apps wait that long; `stop` answers
// 410, and apps stop sending until their core restarts.

declare(strict_types=1);
require __DIR__ . '/../_lib/db.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    header('Allow: POST');
    exit;
}
if (is_file(data_dir() . '/stop')) {
    http_response_code(410);
    exit;
}
if (is_file(data_dir() . '/pause')) {
    $seconds = (int) trim((string) file_get_contents(data_dir() . '/pause'));
    http_response_code(429);
    header('Retry-After: ' . ($seconds > 0 ? $seconds : 3600));
    exit;
}
$body = (string) file_get_contents('php://input', false, null, 0, 8192);
$raw = json_decode($body, true);
$batch = parse_batch($raw);
if (!$batch) {
    http_response_code(400);
    exit;
}
$now = time();
$day = gmdate('Y-m-d', $now);
if (!verify_signature($body, $raw['version'] ?? null, $_SERVER['HTTP_X_CMD_SIGNATURE'] ?? null, $day)) {
    http_response_code(401);
    exit;
}
try {
    // REMOTE_ADDR: Uberspace's proxy sets it to the client; X-Forwarded-For is the client's to fake.
    $wait = rate_limit($_SERVER['REMOTE_ADDR'] ?? '', $batch['id'], $now);
    if ($wait !== null) {
        http_response_code(429);
        header("Retry-After: $wait");
        exit;
    }
    record_batch($batch, $day);
} catch (Throwable $e) {
    error_log('cmd usage: ' . $e->getMessage());
    http_response_code(503);
    header('Retry-After: 600');
    exit;
}
http_response_code(204);
