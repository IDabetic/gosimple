<?php

declare(strict_types=1);

return [
    /*
     * Where the GoSimple runtime is listening.
     *
     * Loopback by default: the runtime binds to 127.0.0.1 and expects to be
     * reached by your application, not by browsers. If you need it on another
     * host, put it behind your own authenticated gateway.
     */
    'url' => env('GOSIMPLE_URL', 'http://127.0.0.1:7777'),

    /*
     * Bearer token. Required only when the runtime was started with
     * GOSIMPLE_TOKEN set; the runtime compares tokens in constant time.
     */
    'token' => env('GOSIMPLE_TOKEN'),

    /*
     * Request timeout in seconds. The runtime caps its own work at 5 seconds,
     * so a longer client timeout buys nothing.
     */
    'timeout' => (int) env('GOSIMPLE_TIMEOUT', 5),
];
