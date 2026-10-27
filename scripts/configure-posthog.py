"""Build public browser configuration from environment; never hard-code project tokens."""
import argparse
import json
import os
from pathlib import Path
from urllib.parse import urlsplit


def write_config(output, root):
    values = {}
    env = Path(root) / '.env.local'
    if env.is_file():
        for line in env.read_text().splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                key, value = line.split('=', 1)
                values[key.strip()] = value.strip().strip('\"\'')
    token = os.environ.get('POSTHOG_PROJECT_TOKEN', values.get('POSTHOG_PROJECT_TOKEN', ''))
    host = os.environ.get('POSTHOG_HOST', values.get('POSTHOG_HOST', ''))
    config = None
    if token and host:
        parsed = urlsplit(host)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.path not in ('', '/') or parsed.query or parsed.fragment:
            raise ValueError('POSTHOG_HOST must be an HTTPS ingestion origin')
        config = {'token': token, 'host': host.rstrip('/')}
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text('/* Generated browser configuration. */\nwindow.SWT_POSTHOG = ' + json.dumps(config).replace('<', '\\u003c') + ';\n')
    return bool(config)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--root', default='.')
    args = parser.parse_args()
    configured = write_config(args.output, args.root)
    print('PostHog browser configuration generated.' if configured else 'PostHog is disabled: set POSTHOG_PROJECT_TOKEN and POSTHOG_HOST to enable it.')
