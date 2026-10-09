<?php
// CHANGELOG.md for the releases page: deploy.sh copies it next to this file;
// run locally, the repo's own is read. Same sections as What's New in the app
// (apps/desktop/src/shared/changelog.ts).

declare(strict_types=1);

/** A section's badge tone, as in What's New (components/WhatsNew.tsx). */
const KIND_TONES = ['New' => 'accent', 'Improved' => 'success', 'Fixed' => 'warning', 'Removed' => 'neutral'];

/** [{version, date, notes}] newest first, notes as Markdown; [] when the file is missing. */
function changelog(): array
{
    $file = is_file(__DIR__ . '/CHANGELOG.md') ? __DIR__ . '/CHANGELOG.md' : __DIR__ . '/../../../CHANGELOG.md';
    $text = is_file($file) ? (string) file_get_contents($file) : '';
    preg_match_all('/^## (\S+) — (\d{4}-\d{2}-\d{2})\R(.*?)(?=^## |\z)/msu', $text, $m, PREG_SET_ORDER);
    return array_map(fn($s) => ['version' => $s[1], 'date' => $s[2], 'notes' => trim($s[3])], $m);
}

/**
 * A release's notes as HTML. Covers what CHANGELOG.md uses: paragraphs,
 * "### " headings (New, Improved… as badges), "- " lists, **bold**, `code`, [links](url) and shortcuts.
 */
function notes_html(string $md): string
{
    $out = '';
    $list = false;
    $para = [];
    $flush = function () use (&$out, &$para) {
        if ($para) $out .= '<p>' . inline(implode(' ', $para)) . "</p>\n";
        $para = [];
    };
    foreach (preg_split('/\R/', trim($md)) as $line) {
        $line = rtrim($line);
        $item = preg_match('/^[-*] (.*)$/', $line, $m);
        if ($list && !$item) {
            $out .= "</ul>\n";
            $list = false;
        }
        if ($item) {
            $flush();
            if (!$list) $out .= '<ul>';
            $list = true;
            $out .= '<li>' . inline($m[1]) . '</li>';
        } elseif (preg_match('/^#{2,4} (.*)$/', $line, $m)) {
            $flush();
            $tone = KIND_TONES[$m[1]] ?? null;
            $out .= '<h3>' . ($tone ? '<span class="badge" data-tone="' . $tone . '">' . h($m[1]) . '</span>' : inline($m[1])) . "</h3>\n";
        } elseif ($line === '') {
            $flush();
        } else {
            $para[] = $line;
        }
    }
    $flush();
    return $out . ($list ? "</ul>\n" : '');
}

/** One line of Markdown: escaped, then bold, links and rich() (code, shortcuts). */
function inline(string $s): string
{
    $s = rich($s);
    $s = preg_replace('/\*\*(.+?)\*\*/', '<strong>$1</strong>', $s);
    return preg_replace_callback('/\[([^\]]+)\]\((https?:[^)\s]+)\)/', fn($m) => '<a href="' . $m[2] . '">' . $m[1] . '</a>', $s);
}
