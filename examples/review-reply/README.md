# review-reply: a GitHub webhook agent behind the gate

`draft` gets each new review comment on your pull requests from a GitHub webhook and drafts a reply.
Every draft waits for you; when you approve it, `post` posts it on the pull request. Because webhook runs
are real inputs, the gate replays the comments you actually received on every new version of `draft`.

## Try it locally, no GitHub needed
With `tidegate dev` running in another terminal:
```sh
cd examples/review-reply
tidegate deploy
tidegate secret set GITHUB_WEBHOOK_SECRET          # type any value, e.g. local-test
GITHUB_WEBHOOK_SECRET=local-test ./send-sample.sh samples/review-comment.json
GITHUB_WEBHOOK_SECRET=local-test ./send-sample.sh samples/question.json
tidegate reviews                                   # two drafts wait for you
```
`send-sample.sh` signs the payload the way GitHub does. Send it with a wrong secret and Tidegate refuses
it; send the same delivery twice and the second starts nothing.

Now make the drafts worse and deploy:
```sh
sed -i.bak 's/"change": f"Looking at/"change": f"Great catch! Looking at/' draft.py
tidegate deploy      # Blocked: worse than the live version on 2 real inputs (eval no_filler)
mv draft.py.bak draft.py && tidegate deploy
```

## Connect a real repo
1. `tidegate status` prints `github_webhook_url`. GitHub must be able to reach it: deploy Tidegate to your
   own Cloudflare account (see the main README), or expose `tidegate dev` with a tunnel such as
   `cloudflared tunnel --url http://localhost:8787` and use the tunnel's address with the same path
   (the signature check follows GitHub's documented example; the tunnel route itself is not yet tested
   against a real GitHub delivery).
2. In the repo: Settings, Webhooks, Add webhook. Payload URL: that address. Content type:
   `application/json`. Secret: the value of `GITHUB_WEBHOOK_SECRET`. Events: "Pull request review
   comments" and "Issue comments".
3. To post approved replies, `tidegate secret set GITHUB_TOKEN` with a token that can write pull request
   comments on that repo. Without it, `post` prints what it would have posted.

Set `ANTHROPIC_API_KEY` to draft with a model; without one `draft` uses a template. Bots, plain issues and
empty comments are skipped and never reach review.
