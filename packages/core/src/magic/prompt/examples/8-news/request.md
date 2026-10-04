Request: live news from berlin
Notes: Google News has an RSS search feed; `fetch` showed <item>s with title, link, pubDate and source. data.ts parses the feed with xmlItems; the view never sees XML. Layout: a feed: a toolbar with the topic and a count, the list filling the rest of the window and scrolling (k-app, k-toolbar, k-main).
