"""Local API process entrypoint and shared console logging configuration."""
import argparse

import uvicorn


def logging_config(level: str = 'info') -> dict[str, object]:
    return {
        'version': 1,
        'disable_existing_loggers': False,
        'formatters': {'console': {
            'format': '%(asctime)s %(levelname)-7s %(name)s %(message)s',
            'datefmt': '%Y-%m-%d %H:%M:%S',
        }},
        'handlers': {'console': {
            'class': 'logging.StreamHandler', 'formatter': 'console', 'stream': 'ext://sys.stderr',
        }},
        'root': {'handlers': ['console'], 'level': 'INFO'},
        'loggers': {
            'opendirector': {'handlers': [], 'level': level.upper(), 'propagate': True},
            'uvicorn': {'handlers': [], 'level': level.upper(), 'propagate': True},
            'uvicorn.error': {'handlers': [], 'level': level.upper(), 'propagate': True},
            'uvicorn.access': {'handlers': [], 'level': level.upper(), 'propagate': True},
            'httpx': {'handlers': [], 'level': 'WARNING', 'propagate': True},
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description='Run the OpenDirector API')
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--log-level', choices=('debug', 'info', 'warning', 'error', 'critical'), default='info')
    args = parser.parse_args()
    seed_builtin_placeholder()
    uvicorn.run('opendirector_api.main:create_app', factory=True, host='127.0.0.1', port=args.port,
                log_config=logging_config(args.log_level))


def seed_builtin_placeholder() -> None:
    """Production startup seeds the zero-key placeholder generator once.

    Test entry points build create_app directly and keep their own catalogs,
    so the seed lives here instead of the app factory. A models.json that
    cannot be read keeps surfacing on first use; never block startup on it.
    """
    from opendirector.domain.projects import ProjectError
    from opendirector.infrastructure.model_configs import ModelConfigs
    from opendirector.installation import data_root

    try:
        ModelConfigs(data_root()).ensure_builtin()
    except ProjectError:
        pass


if __name__ == '__main__':
    main()
