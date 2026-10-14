<?php

declare(strict_types=1);

namespace GoSimple;

use Illuminate\Contracts\Foundation\Application;
use Illuminate\Support\ServiceProvider;

/**
 * Laravel service provider for the GoSimple client.
 *
 * Register it in bootstrap/providers.php (Laravel 11+) or in the providers
 * array of config/app.php, then type-hint GoSimple anywhere:
 *
 *     public function search(Request $request, GoSimple $gs) { ... }
 *
 * Configuration comes from the environment:
 *
 *     GOSIMPLE_URL=http://127.0.0.1:7777
 *     GOSIMPLE_TOKEN=...
 *     GOSIMPLE_TIMEOUT=5
 *
 * The default URL is loopback on purpose. The runtime binds to 127.0.0.1 and
 * is meant to sit behind your application, not in front of your users.
 */
final class GoSimpleServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(GoSimple::class, static function (Application $app): GoSimple {
            /** @var \Illuminate\Contracts\Config\Repository $config */
            $config = $app->make('config');

            return new GoSimple(
                (string) $config->get('gosimple.url', env('GOSIMPLE_URL', 'http://127.0.0.1:7777')),
                $config->get('gosimple.token', env('GOSIMPLE_TOKEN')),
                (int) $config->get('gosimple.timeout', env('GOSIMPLE_TIMEOUT', 5)),
            );
        });

        $this->mergeConfigFrom(__DIR__ . '/config/gosimple.php', 'gosimple');
    }

    public function boot(): void
    {
        if ($this->app->runningInConsole()) {
            $this->publishes([
                __DIR__ . '/config/gosimple.php' => $this->app->configPath('gosimple.php'),
            ], 'gosimple-config');
        }
    }

    /** @return list<class-string> */
    public function provides(): array
    {
        return [GoSimple::class];
    }
}
