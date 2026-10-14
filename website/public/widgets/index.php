<?php
// The widget API reference: how to make a widget package, then every verb, hook and element of
// @cmd/widget-api. The body is generated (_lib/widget-api.html, pnpm widget-api:docs); this
// page only puts it in the site's layout. The template's CLAUDE.md links here.

declare(strict_types=1);
require __DIR__ . '/../_lib/layout.php';

page_start('cmd widgets: the API reference', 'Make a cmd widget: a package of React and cmd’s own elements, live with your agents and terminals.', 'widgets/');
?>
<style>
.api-table { overflow-x: auto; margin: 0 0 12px; }
.api-table td, .api-table th { white-space: normal; vertical-align: top; }
.api-table td:first-child { min-width: 16em; }
.api-table code { word-break: break-word; }
pre { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; overflow-x: auto; font: var(--fs-sm)/1.6 var(--mono); }
h3 { margin: 32px 0 8px; }
h4 { margin: 24px 0 6px; }
.api-toc { line-height: 2; }
</style>
<?php
readfile(__DIR__ . '/../_lib/widget-api.html');
page_end();
