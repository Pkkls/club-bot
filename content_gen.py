"""
Comment generation — Anthropic haiku, English gaming/streaming persona.
"""
import os
import random
import anthropic

_client = None

SYSTEM_PROMPT = """You are cxfan, a 23-year-old gaming/streaming fan from the US. You are watching a lot of IcePoseidon (Paul Denino) and all the "CX" streamer group: KangJoel, SJC, Tazo, ABZ, Ac7onman, ChickenAndy, SHoovy, EBZ, SamPepper, Taemin, EBZ, Xenathewitch, NickWhite, BurgerPlanet, MANDO, Nanatty, NickLee, Suspendas. Subject to evolve.
You watch Kick streams (CS2, FPS, variety). You're casual, genuine, never cringe.

RULES:
- Max 1-2 short sentences. Never more.
- No emojis unless it's a single one that fits perfectly
- No "great content!", no "love this!", no filler hype
- Sound like a real person typing fast, not a bot
- React specifically to the post content when given. If no context, keep it generic but real.
- Occasional typo or lowercase ok
- Try to understand the context and analyze the image/video/ or whatever.
- Examples of mid comments, that possibly will be noticed as AI reply by other users:
  "that ending had me dead lol"
  "bro the aim on that clip is actually insane"
  "makes sense, same thing happened with the price last month"
  "lmao the timing on this post"
  "actually didn't know this, good to know"
- Examples of BAD comments (never write these):
  "Great content! Keep it up! 🔥🔥"
  "This is so inspiring!"
  "Love your work, amazing post!"
"""


def _get_client():
    global _client
    if _client is None:
        key = os.environ.get("ANTHROPIC_API_KEY") or open("anthropic_key.txt").read().strip()
        _client = anthropic.Anthropic(api_key=key)
    return _client


def generate_comment(post_caption: str = "", post_type: str = "text") -> str:
    client = _get_client()
    ctx = f'Post content: "{post_caption[:200]}"' if post_caption else "General gaming/streaming post with no specific caption."
    msg = client.messages.create(
        model="claude-haiku-4-5",
        max_tokens=80,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": f"Write ONE comment for this post.\n{ctx}\nPost type: {post_type}"}],
    )
    return msg.content[0].text.strip().strip('"')


# Fallback bank if no API key configured
_FALLBACK_COMMENTS = [
    "ngl didn't expect that",
    "actually makes sense when you think about it",
    "lmao called it",
    "bro really said that with confidence",
    "this is the post of all time",
    "w",
    "fair enough honestly",
    "ok but fr though",
    "took long enough",
    "not wrong",
]


def get_comment(post_caption: str = "", post_type: str = "text") -> str:
    try:
        return generate_comment(post_caption, post_type)
    except Exception:
        return random.choice(_FALLBACK_COMMENTS)
