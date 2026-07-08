from pathlib import Path
import re

files = [
    'admin.html',
    'event-registration.html',
    'index.html',
    'live-event-details.html',
    'organizer-dashboard.html',
    'organizer-login.html',
    'success.html',
    'ticket-checkout.html',
    'ticket-success.html',
    'vote-checkout.html',
    'voting-home.html',
]

pattern = re.compile(
    r"body\s*\{[^}]*background\s*:\s*#ffffff;[^}]*color\s*:\s*#111111;[^}]*\}",
    re.IGNORECASE | re.DOTALL,
)

replacement = (
    "body{\n"
    "  margin:0;\n"
    "  overflow-x:hidden;\n"
    "  background: radial-gradient(circle at top left, rgba(96,165,250,0.18), transparent 24%),\n"
    "              radial-gradient(circle at top right, rgba(59,130,246,0.12), transparent 18%),\n"
    "              linear-gradient(180deg, #060918 0%, #0e1726 100%);\n"
    "  color:#f8fafc;\n"
    "  font-family:Arial, Helvetica, sans-serif;\n"
    "}\n"
)

for name in files:
    path = Path(name)
    if not path.exists():
        print('missing', name)
        continue
    text = path.read_text(encoding='utf-8')
    new_text = pattern.sub(replacement, text, count=1)
    if new_text != text:
        path.write_text(new_text, encoding='utf-8')
        print('patched', name)
    else:
        print('no match', name)
