import sys
from gtts import gTTS

if len(sys.argv) != 4:
    print("Usage: gtts_fallback.py <language> <text> <output>", file=sys.stderr)
    sys.exit(2)

language, text, output_path = sys.argv[1], sys.argv[2], sys.argv[3]

if language not in ("ur", "en"):
    language = "ur"

gTTS(text=text, lang=language).save(output_path)
