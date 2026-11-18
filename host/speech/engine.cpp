// tasktap-speech: speech into text on this machine (design §8, "On this device"). Whisper, through whisper.cpp, in a
// process of its own that lives exactly as long as one dictation: the host starts it when the person begins to speak,
// writes what the page records to its standard input, and it is gone when it has printed the transcript. Nothing is
// loaded before and nothing stays after. It opens no microphone, no file but its model, and no connection.
//
//   tasktap-speech <model.bin> [language ...]      languages as ISO 639-1, the person's (`speech_languages`)
//   in:   16 kHz, one channel, signed 16-bit little-endian, until the end of input (the person let go)
//   out:  one JSON object a line: {"ready":true}, then {"partial":"the transcript so far"} as it grows,
//         then {"final":"the whole transcript"}; or {"error":"model"} / {"error":"engine"}
//
// Whisper hears a stretch of at most 30 s at once, and its cost is the same for one second as for thirty. So the
// recording is cut where the person pauses, once a stretch is ten seconds long (at 28 s wherever it is quietest), and
// each stretch is written down while they speak on: the words appear a sentence or two behind, and when they let go
// only the last stretch is left, however long they spoke. A stretch in which nothing rises above the noise is not
// given to the model at all, which would invent words for it.
//
// Languages: none given, the model decides; one, it is told. Several: each stretch is written in the one of them the
// model finds likelier in the first four seconds of its speech, whatever their order, and a stretch that ends sooner
// than that stays in the language of the stretch before it. Told the wrong language Whisper translates, both ways, so the
// language is never fixed for a whole thought; told the language a stretch begins in, it writes down what follows
// in the other as it was said. Four seconds, because three were too few for a German sentence that begins with an
// English word, and all of a stretch too many for one that changes language on the way; and a few words at the end
// of a thought are too little to tell by (design §8, "On this device", has the numbers, in a person's voice).
#include <algorithm>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>

#include "whisper.h"

static const int RATE = 16000, FRAME = 320;                         // a frame is 20 ms
static const size_t STRETCH = 6 * RATE, LONGEST = 28 * RATE;         // cut at a pause from 6 s on, at the latest at 28 s
static const int PAUSE = 15;                                         // frames: a third of a second of quiet is a pause
static const size_t EARLY = 4 * RATE;                                // what a stretch's language is told by

static void say(const char *key, const std::string &text) {
    std::string out = std::string("{\"") + key + "\":\"";
    for (unsigned char c : text) {
        if (c == '"' || c == '\\') (out += '\\') += (char)c;
        else if (c < 0x20) { char u[8]; snprintf(u, sizeof u, "\\u%04x", c); out += u; }
        else out += (char)c;
    }
    out += "\"}\n";
    fwrite(out.data(), 1, out.size(), stdout);
    fflush(stdout);
}

struct Job { size_t from, to; bool last, detect; };

static std::mutex lock;
static std::condition_variable woke;
static std::vector<float> audio;       // the whole recording, 300 s at most (the core's bound)
static std::deque<Job> jobs;

// Whisper's own words for what is not speech, and the blanks around a stretch.
static std::string tidy(std::string text) {
    for (const char *open : {"[", "("}) {
        const char close = *open == '[' ? ']' : ')';
        for (size_t a; (a = text.find(open)) != std::string::npos;) {
            size_t b = text.find(close, a);
            if (b == std::string::npos) break;
            text.erase(a, b - a + 1);
        }
    }
    size_t a = text.find_first_not_of(" \t\n"), b = text.find_last_not_of(" \t\n");
    return a == std::string::npos ? "" : text.substr(a, b - a + 1);
}

int main(int argc, char **argv) {
    if (argc < 2) return 2;
    std::vector<std::string> languages;
    for (int i = 2; i < argc; i++) {
        std::string code = std::string(argv[i]).substr(0, std::string(argv[i]).find('-'));
        if (whisper_lang_id(code.c_str()) >= 0 && std::find(languages.begin(), languages.end(), code) == languages.end()) languages.push_back(code);
    }
    whisper_log_set([](enum ggml_log_level, const char *, void *) {}, nullptr);

    std::thread worker([&] {
        whisper_context_params how = whisper_context_default_params();
        whisper_context *ctx = whisper_init_from_file_with_params(argv[1], how);
        if (!ctx) { say("error", "model"); _exit(3); }
        fputs("{\"ready\":true}\n", stdout);
        fflush(stdout);
        const int threads = std::max(1, std::min(4, (int)std::thread::hardware_concurrency()));
        std::string language = languages.size() == 1 ? languages[0] : languages.empty() ? "auto" : "", text;
        // The likelier of the person's languages in what the model heard last; the one before, where they are level.
        auto likelier = [&] {
            const whisper_token start = whisper_token_sot(ctx);
            if (whisper_decode(ctx, &start, 1, 0, threads) != 0) return;
            auto odds = [&](const std::string &l) { return whisper_get_logits(ctx)[whisper_token_lang(ctx, whisper_lang_id(l.c_str()))]; };
            for (auto &l : languages) if (language.empty() || odds(l) > odds(language)) language = l;
        };
        for (;;) {
            Job job;
            std::vector<float> part;
            {
                std::unique_lock<std::mutex> held(lock);
                woke.wait(held, [] { return !jobs.empty(); });
                job = jobs.front();
                jobs.pop_front();
                part.assign(audio.begin() + job.from, audio.begin() + job.to);
            }
            // The first four seconds of a stretch, heard while the person speaks on.
            if (job.detect && whisper_pcm_to_mel(ctx, part.data(), (int)part.size(), threads) == 0 && whisper_encode(ctx, 0, threads) == 0) likelier();
            if (!job.detect && !part.empty()) {
                // Whisper wants a second of sound at the least.
                if (part.size() < (size_t)RATE + 1600) part.resize(RATE + 1600, 0.f);
                // A thought that ends before four seconds has no language yet: it is written in the first of them,
                // told by all of it, which the model has heard by then, and written again only if it was another.
                for (bool guess = language.empty();; guess = false) {
                    if (guess) language = languages[0];
                    whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_BEAM_SEARCH);
                    params.n_threads = threads;
                    params.language = language.c_str();
                    params.no_context = params.no_timestamps = params.single_segment = params.suppress_nst = true;
                    params.print_progress = params.print_realtime = params.print_timestamps = params.print_special = false;
                    if (whisper_full(ctx, params, part.data(), (int)part.size()) != 0) { say("error", "engine"); _exit(4); }
                    if (guess) likelier();
                    if (!guess || language == languages[0]) break;
                }
                std::string heard;
                for (int i = 0; i < whisper_full_n_segments(ctx); i++) heard += whisper_full_get_segment_text(ctx, i);
                heard = tidy(heard);
                if (!heard.empty()) text += (text.empty() ? "" : " ") + heard;
                if (!job.last) say("partial", text);
            }
            if (job.last) {
                say("final", text);
                // No tidying up: the process ends, and with it everything it held.
                _exit(0);
            }
        }
    });

    // The recording as it comes: its loudness frame by frame, and a cut wherever the person pauses.
    std::vector<float> loud;                    // each frame's level (RMS)
    size_t begun = 0, heard = 0, seen = 0;      // where the stretch under way began; samples read; frames looked at
    size_t first = SIZE_MAX, speech = SIZE_MAX; // where the stretch under way has its first sound, and where its speech begins
    float top = 0;                              // the loudest frame yet
    bool told = languages.size() < 2;           // the stretch under way has its language, or is being told it
    // A pause is a tenth of the loudest (20 dB under it); a stretch with nothing above a thirtieth (30 dB) holds no words.
    auto under = [&](size_t frame, float part) { return loud[frame] < std::max(top * part, 0.002f); };
    auto post = [&](Job job) {
        { std::lock_guard<std::mutex> held(lock); jobs.push_back(job); }
        woke.notify_one();
    };
    std::vector<unsigned char> carry;
    unsigned char buf[6400];
    for (ssize_t n; (n = read(0, buf, sizeof buf)) > 0;) {
        carry.insert(carry.end(), buf, buf + n);
        const size_t samples = carry.size() / 2;
        {
            std::lock_guard<std::mutex> held(lock);
            for (size_t i = 0; i < samples; i++) audio.push_back((int16_t)(carry[2 * i] | carry[2 * i + 1] << 8) / 32768.f);
            heard = audio.size();
            for (; (loud.size() + 1) * FRAME <= heard; ) {
                double sum = 0;
                for (size_t i = loud.size() * FRAME, end = i + FRAME; i < end; i++) sum += audio[i] * audio[i];
                loud.push_back((float)std::sqrt(sum / FRAME));
                top = std::max(top, loud.back());
            }
        }
        carry.erase(carry.begin(), carry.begin() + 2 * samples);
        // A stretch begins in the pause it was cut at: its language is told from where that pause ends.
        auto look = [&](size_t f) {
            if (first == SIZE_MAX && !under(f, 0.03f)) first = f * FRAME;
            if (speech == SIZE_MAX && !under(f, 0.1f)) speech = f * FRAME;
        };
        for (; seen < loud.size(); seen++) look(seen);
        if (!told && speech != SIZE_MAX && heard >= speech + EARLY) told = true, post({speech, speech + EARLY, false, true});
        size_t cut = 0;
        if (heard - begun >= LONGEST) {
            // No pause in 28 s: cut at the quietest frame of the last three seconds.
            size_t at = loud.size() - 1;
            for (size_t f = loud.size() - 150; f < loud.size(); f++) if (loud[f] < loud[at]) at = f;
            cut = at * FRAME;
        } else if (heard - begun >= STRETCH) {
            bool pause = true;
            for (size_t f = loud.size() - PAUSE; f < loud.size(); f++) pause = pause && under(f, 0.1f);
            // In the middle of the pause, so neither side loses the edge of a word.
            if (pause) cut = (loud.size() - PAUSE / 2) * FRAME;
        }
        if (cut > begun) {
            if (first < cut) post({begun, cut, false, false});
            begun = cut, first = speech = SIZE_MAX, told = languages.size() < 2;
            for (size_t f = cut / FRAME; f < loud.size(); f++) look(f);
        }
    }
    // The person let go: what is left, if anything was said in it.
    post({begun, first != SIZE_MAX ? heard : begun, true, false});
    worker.join();
    return 0;
}
