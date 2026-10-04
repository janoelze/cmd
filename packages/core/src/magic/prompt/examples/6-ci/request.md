Request: ci status
Notes: the workspace ~/src/shop is a git repository on github.com/acme/shop; `gh auth status` is logged in, so data.ts uses gh (logged in, no rate limits) rather than api.github.com. run_data showed passing runs only, so fixtures/failing.json covers a failed and a running one.
