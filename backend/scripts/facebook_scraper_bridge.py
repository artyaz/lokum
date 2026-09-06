#!/usr/bin/env python3
"""JSON-lines bridge around kevinzg/facebook-scraper."""

import json
import os
import signal
import sys
import time
from datetime import datetime, timezone
from urllib.parse import quote


FATAL_ERRORS = {"LoginRequired", "LoginError", "InvalidCookies", "AccountNotFound"}


def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def read_request():
    raw = sys.stdin.read()
    if not raw.strip():
        raise ValueError("empty bridge request")
    request = json.loads(raw)
    if not isinstance(request.get("groups"), list):
        raise ValueError("request.groups must be an array")
    return request


def cookiejar_from_list(cookies):
    from requests.cookies import RequestsCookieJar

    jar = RequestsCookieJar()
    for cookie in cookies:
        jar.set(
            cookie["name"],
            cookie["value"],
            domain=cookie.get("domain") or ".facebook.com",
            path=cookie.get("path") or "/",
            secure=bool(cookie.get("secure", True)),
            expires=int(cookie["expirationDate"])
            if cookie.get("expirationDate") not in (None, "")
            else None,
        )
    return jar


def cookie_source(request):
    provided = request.get("cookies")
    if isinstance(provided, list) and provided:
        return {"cookies": cookiejar_from_list(provided)}
    if isinstance(provided, dict) and provided:
        return {"cookies": provided}

    cookies = os.getenv("FACEBOOK_COOKIES", "").strip()
    if cookies:
        return {"cookies": cookies}

    email = os.getenv("FACEBOOK_EMAIL", "").strip()
    password = os.getenv("FACEBOOK_PASSWORD", "")
    if email and password:
        return {"credentials": (email, password)}
    return {}


def has_auth(request):
    return bool(cookie_source(request))


def sanitize_post(post):
    """Keep only the fields Lokum consumes.

    facebook-scraper can attach large comment/reaction/share structures to every
    post. Serializing all of them over the pipe wastes CPU in json.dumps and
    transient memory in both processes; Lokum never reads those fields.
    """
    if not isinstance(post, dict):
        return {}

    text = post.get("post_text") or post.get("text") or ""
    images = post.get("images")
    if not isinstance(images, list):
        images = []
    else:
        images = list(images)
    if post.get("image"):
        images.append(post["image"])

    posted_at = post.get("time")
    if isinstance(posted_at, datetime):
        if posted_at.tzinfo is None:
            posted_at = posted_at.replace(tzinfo=timezone.utc)
        posted_at = posted_at.astimezone(timezone.utc).isoformat()

    result = {
        "post_id": post.get("post_id"),
        "post_text": text,
        "header": post.get("header"),
        "post_url": post.get("post_url"),
        "w3_fb_url": post.get("w3_fb_url"),
        "time": posted_at,
        "images": [url for url in images if url][:12],
        "username": post.get("username"),
        "likes": post.get("likes"),
        "comments": post.get("comments"),
        "shares": post.get("shares"),
        "link": post.get("link"),
    }
    return result


def fatal_exception(exc):
    return exc.__class__.__name__ in FATAL_ERRORS


def main():
    request = read_request()
    soft_timeout = max(30, int(request.get("soft_timeout_seconds", 900)))

    def timeout_handler(*_args):
        raise TimeoutError(f"bridge exceeded {soft_timeout}s")

    signal.signal(signal.SIGALRM, timeout_handler)
    signal.alarm(soft_timeout)

    if request.get("dry_run"):
        for group in request["groups"]:
            emit({"type": "group_start", "group_id": group["group_id"]})
            emit(
                {
                    "type": "post",
                    "group_id": group["group_id"],
                    "post": {
                        "post_id": f"dry-run-{group['group_id']}",
                        "time": None,
                        "post_url": group.get("url"),
                        "text": "Dry-run Facebook post: 2 pokoje, 45 m2, 3 800 zł, Mokotów",
                        "images": [],
                        "username": group.get("name"),
                    },
                }
            )
            emit({"type": "group_done", "group_id": group["group_id"], "count": 1})
        emit({"type": "done", "groups": len(request["groups"]), "posts": len(request["groups"])})
        return 0

    if request.get("require_auth", True) and not has_auth(request):
        emit(
            {
                "type": "fatal",
                "error": "No authenticated Facebook session configured; set FACEBOOK_COOKIES",
                "groups": 0,
                "posts": 0,
            }
        )
        return 2

    from facebook_scraper import get_posts

    auth = cookie_source(request)
    base_url = request.get("base_url", "https://mbasic.facebook.com").rstrip("/")
    pages = int(request.get("pages", 3))
    timeout = int(request.get("timeout_seconds", 30))
    delay_ms = max(0, int(request.get("group_delay_ms", 750)))
    max_posts_per_group = max(0, int(request.get("max_posts_per_group", 0)))
    latest_date = request.get("latest_date")
    options = {
        "allow_extra_requests": False,
        "posts_per_page": int(request.get("posts_per_page", 25)),
    }
    total_posts = 0
    completed_groups = 0

    for index, group in enumerate(request["groups"]):
        group_id = str(group["group_id"])
        emit({"type": "group_start", "group_id": group_id})
        count = 0
        try:
            start_url = f"{base_url}/groups/{quote(group_id, safe='')}"
            kwargs = {
                "pages": pages,
                "timeout": timeout,
                "start_url": start_url,
                "options": options,
                **auth,
            }
            if latest_date:
                kwargs["latest_date"] = datetime.fromisoformat(
                    latest_date.replace("Z", "+00:00")
                )

            for post in get_posts(group=group_id, **kwargs):
                count += 1
                total_posts += 1
                emit({"type": "post", "group_id": group_id, "post": sanitize_post(post)})
                if max_posts_per_group and count >= max_posts_per_group:
                    break

            emit({"type": "group_done", "group_id": group_id, "count": count})
            completed_groups += 1
        except Exception as exc:
            error = f"{exc.__class__.__name__}: {exc}"
            emit({"type": "group_error", "group_id": group_id, "error": error})
            if fatal_exception(exc):
                emit(
                    {
                        "type": "fatal",
                        "error": error,
                        "groups": completed_groups,
                        "posts": total_posts,
                    }
                )
                return 2
        finally:
            if index + 1 < len(request["groups"]) and delay_ms:
                time.sleep(delay_ms / 1000)

    emit({"type": "done", "groups": completed_groups, "posts": total_posts})
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:
        error = f"{exc.__class__.__name__}: {exc}"
        emit({"type": "fatal", "error": error, "groups": 0, "posts": 0})
        raise SystemExit(2)
