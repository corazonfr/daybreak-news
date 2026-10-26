# Daybreak News

Today's news in one fun page: world headlines, what everyone is reading, tech, space, a daily Higher-or-Lower game, Florida Man of the day and On This Day. Free for everyone, with no accounts, ads or tracking.

**Live site:** https://corazonfr.github.io/daybreak-news/

## How it stays fresh

There's no server and no build step. Each visitor's browser fetches the latest stories from free, no-key public APIs when the page opens, and again every 30 minutes while it stays open.

| Section | Source |
|---|---|
| The Brief, Trending, Higher or Lower, Picture of the day, On this day | [Wikipedia featured feed](https://api.wikimedia.org/wiki/Feed_API) |
| World wire | [Wikipedia Current Events portal](https://en.wikipedia.org/wiki/Portal:Current_events) |
| Tech | [Hacker News API](https://github.com/HackerNews/API) |
| Space | [Spaceflight News API](https://spaceflightnewsapi.net) |
| Weird | [Florida Man API](https://github.com/juliayxhuang/florida-man-api) |
| Weather | [Open-Meteo](https://open-meteo.com) |

The APIs were picked from [public-apis](https://github.com/public-apis/public-apis).

## Run it locally

Serve the folder over HTTP (opening the file directly breaks some requests):

```bash
python -m http.server 8765
```

Then open http://127.0.0.1:8765.
