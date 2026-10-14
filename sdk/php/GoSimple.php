<?php

declare(strict_types=1);

namespace GoSimple;

use JsonException;
use RuntimeException;

/**
 * GoSimple PHP client.
 *
 * Talks to a GoSimple runtime over HTTP. Works in plain PHP and in Laravel;
 * see GoSimpleServiceProvider.php for container wiring.
 *
 * The client deliberately does not accept a .gs program. Programs are
 * compiled by the runtime at startup from a file on disk, so an application
 * bug cannot turn into remote code execution against the search engine.
 */
final class GoSimple
{
    private string $baseUrl;
    private ?string $token;
    private int $timeoutSeconds;

    public function __construct(string $baseUrl, ?string $token = null, int $timeoutSeconds = 5)
    {
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->token = $token;
        $this->timeoutSeconds = $timeoutSeconds;
    }

    /**
     * Runs a search.
     *
     * @param array{
     *   user?: array{id?: string, budget?: float, interests?: list<string>, seenIds?: list<string>},
     *   season?: string,
     *   now?: string
     * } $options
     *
     * @return SearchResult
     */
    public function search(string $query, array $options = []): SearchResult
    {
        $payload = array_merge(['query' => $query], $options);
        return SearchResult::fromArray($this->post('/search', $payload));
    }

    /**
     * Returns recommendations for a user, a seed item, or neither.
     *
     * Always check isPersonalized() before labelling the result. A cold slate
     * is a popularity list, and presenting it as "picked for you" is a claim
     * the data does not support.
     *
     * @param array{
     *   userId?: string,
     *   seedIds?: list<string>,
     *   excludeIds?: list<string>,
     *   interests?: list<string>,
     *   budget?: float,
     *   season?: string,
     *   now?: string
     * } $options
     */
    public function recommend(array $options = []): RecommendResult
    {
        return RecommendResult::fromArray($this->post('/recommend', $options));
    }

    /**
     * Analyzes a block of text and returns writing features with evidence.
     *
     * The result reports observable properties and a confidence value. It
     * never asserts who or what wrote the text.
     *
     * @return array<string, mixed>
     */
    public function analyzeContent(string $text): array
    {
        return $this->post('/content', ['text' => $text]);
    }

    /** @return array<string, mixed> */
    public function health(): array
    {
        return $this->get('/health');
    }

    /**
     * Asks the runtime to re-read the source it was started with.
     *
     * The catalogue never travels in this request; the server rejects a body.
     * Requires the runtime to run with GOSIMPLE_TOKEN.
     *
     * @return array{status: string, documents: int, added: int, updated: int, removed: int}
     */
    public function reload(): array
    {
        return $this->request('POST', '/reload', null);
    }

    /** @return array<string, mixed> The compiled IR plan currently in effect. */
    public function plan(): array
    {
        return $this->get('/plan');
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    private function post(string $path, array $payload): array
    {
        try {
            $body = json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
        } catch (JsonException $e) {
            throw new RuntimeException('Zahtev se ne može serijalizovati u JSON: ' . $e->getMessage(), 0, $e);
        }

        return $this->request('POST', $path, $body);
    }

    /** @return array<string, mixed> */
    private function get(string $path): array
    {
        return $this->request('GET', $path, null);
    }

    /** @return array<string, mixed> */
    private function request(string $method, string $path, ?string $body): array
    {
        $headers = ['Accept: application/json'];
        if ($body !== null) {
            $headers[] = 'Content-Type: application/json';
        }
        if ($this->token !== null) {
            $headers[] = 'Authorization: Bearer ' . $this->token;
        }

        $context = stream_context_create([
            'http' => [
                'method' => $method,
                'header' => implode("\r\n", $headers),
                'content' => $body ?? '',
                'timeout' => $this->timeoutSeconds,
                // Read the body on 4xx/5xx so the server's error message survives.
                'ignore_errors' => true,
            ],
        ]);

        $response = @file_get_contents($this->baseUrl . $path, false, $context);
        if ($response === false) {
            throw new RuntimeException("GoSimple runtime nije dostupan na {$this->baseUrl}{$path}");
        }

        $status = $this->statusFrom($http_response_header ?? []);

        try {
            /** @var array<string, mixed> $decoded */
            $decoded = json_decode($response, true, 512, JSON_THROW_ON_ERROR);
        } catch (JsonException $e) {
            throw new RuntimeException('GoSimple je vratio odgovor koji nije JSON', 0, $e);
        }

        if ($status >= 400) {
            $message = is_string($decoded['error'] ?? null) ? $decoded['error'] : 'nepoznata greška';
            throw new RuntimeException("GoSimple greška {$status}: {$message}");
        }

        return $decoded;
    }

    /** @param list<string> $headers */
    private function statusFrom(array $headers): int
    {
        foreach ($headers as $header) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $header, $matches) === 1) {
                return (int) $matches[1];
            }
        }
        return 0;
    }
}

/**
 * Typed view over a search response.
 */
final class SearchResult
{
    /** @param list<array<string, mixed>> $hits */
    private function __construct(
        public readonly string $query,
        public readonly string $season,
        public readonly ?string $intentCategory,
        public readonly bool $intentLocked,
        public readonly bool $ambiguous,
        public readonly ?array $clarify,
        public readonly array $hits,
        public readonly array $stats,
        public readonly array $raw,
    ) {
    }

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        /** @var array<string, mixed> $intent */
        $intent = $data['intent'] ?? [];

        return new self(
            (string) ($data['query'] ?? ''),
            (string) ($data['season'] ?? ''),
            isset($intent['category']) && is_string($intent['category']) ? $intent['category'] : null,
            (bool) ($intent['locked'] ?? false),
            (bool) ($intent['ambiguous'] ?? false),
            is_array($data['clarify'] ?? null) ? $data['clarify'] : null,
            is_array($data['hits'] ?? null) ? $data['hits'] : [],
            is_array($data['stats'] ?? null) ? $data['stats'] : [],
            $data,
        );
    }

    /**
     * True when the engine could not tell what the user meant and the UI
     * should ask rather than guess.
     */
    public function needsClarification(): bool
    {
        return $this->clarify !== null;
    }

    /** @return list<string> */
    public function ids(): array
    {
        return array_values(array_map(
            static fn (array $hit): string => (string) ($hit['id'] ?? ''),
            $this->hits,
        ));
    }
}

/**
 * Typed view over a recommendation response.
 */
final class RecommendResult
{
    /** @param list<array<string, mixed>> $items */
    private function __construct(
        /** 'warm', 'cool' or 'cold'. */
        public readonly string $strategy,
        public readonly string $season,
        public readonly int $userHistorySize,
        public readonly array $items,
        public readonly array $stats,
        public readonly array $raw,
    ) {
    }

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            (string) ($data['strategy'] ?? 'cold'),
            (string) ($data['season'] ?? ''),
            (int) ($data['userHistorySize'] ?? 0),
            is_array($data['items'] ?? null) ? $data['items'] : [],
            is_array($data['stats'] ?? null) ? $data['stats'] : [],
            $data,
        );
    }

    /**
     * True when the slate was built from this user's own behaviour.
     *
     * When false the list is based on popularity and season, which is a
     * reasonable thing to show but not a reasonable thing to call personal.
     */
    public function isPersonalized(): bool
    {
        return $this->strategy === 'warm';
    }

    /** @return list<string> */
    public function ids(): array
    {
        return array_values(array_map(
            static fn (array $item): string => (string) ($item['id'] ?? ''),
            $this->items,
        ));
    }
}
