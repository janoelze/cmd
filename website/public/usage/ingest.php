<?php
// POST endpoint for the app's usage batches (packages/core/src/usage.ts). Takes
// JSON, keeps only known counter names (lib/db.php) and answers 204. The
// sender's IP isn't read or stored.
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
$body = file_get_contents('php://input', false, null, 0, 8192);
$batch = parse_batch(json_decode($body ?: '', true));
if (!$batch) {
    http_response_code(400);
    exit;
}
try {
    record_batch($batch, gmdate('Y-m-d'));
} catch (Throwable $e) {
    error_log('cmd usage: ' . $e->getMessage());
    http_response_code(503);
    header('Retry-After: 600');
    exit;
}
http_response_code(204);
