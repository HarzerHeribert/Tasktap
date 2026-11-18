// probe: what a rule for the language of a stretch has to go on (design §8, "How the rule was found"). It cuts a
// recording into stretches exactly as the app's helper does (host/speech/engine.cpp) and prints, one JSON object a
// stretch: where it lies, how likely the model finds German and English in the first two, three, four and five
// seconds of its speech (`lead`: the pause before it) and in all of it (p2 … p5, p0; `top` is the likeliest of all
// languages), and what the
// model writes for it told each language named. rules.py scores any rule from that without running it.
//
//   probe <model.bin> <file.wav> [language ...]      16 kHz mono 16-bit with a header of 44 bytes
//   PROMPT=<text>   an initial prompt for every stretch      TINC=0   no temperature fallback
//   WHOLE=1         the recording as one stretch, silent or not (what the model makes of silence)
//
// Built by run.sh against the whisper.cpp the helper is built with.
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <unistd.h>
#include <vector>

#include "whisper.h"

static const int RATE = 16000, FRAME = 320, PAUSE = 15;             // as engine.cpp has them
static const size_t STRETCH = 6 * RATE, LONGEST = 28 * RATE;

static std::string quoted(const std::string &text) {
    std::string out;
    for (unsigned char c : text) {
        if (c == '"' || c == '\\') (out += '\\') += (char)c;
        else if (c < 0x20) { char u[8]; snprintf(u, sizeof u, "\\u%04x", c); out += u; }
        else out += (char)c;
    }
    return out;
}

int main(int argc, char **argv) {
    if (argc < 3) return 2;
    FILE *file = fopen(argv[2], "rb");
    if (!file) return 2;
    fseek(file, 44, SEEK_SET);
    std::vector<int16_t> raw(300 * RATE);
    raw.resize(fread(raw.data(), 2, raw.size(), file));
    std::vector<float> audio(raw.size());
    for (size_t i = 0; i < raw.size(); i++) audio[i] = raw[i] / 32768.f;
    whisper_log_set([](enum ggml_log_level, const char *, void *) {}, nullptr);
    whisper_context *ctx = whisper_init_from_file_with_params(argv[1], whisper_context_default_params());
    if (!ctx) return 3;
    const int threads = 4;
    const char *prompt = getenv("PROMPT"), *tinc = getenv("TINC"), *whole = getenv("WHOLE");

    // The cuts, as the helper makes them when it is fed a tenth of a second at a time.
    struct Part { size_t from, to, speech; };
    std::vector<Part> parts;
    std::vector<float> loud;
    size_t begun = 0, first = SIZE_MAX, speech = SIZE_MAX;
    float top = 0;
    auto under = [&](size_t frame, float part) { return loud[frame] < std::max(top * part, 0.002f); };
    auto look = [&](size_t f) {
        if (first == SIZE_MAX && !under(f, 0.03f)) first = f * FRAME;
        if (speech == SIZE_MAX && !under(f, 0.1f)) speech = f * FRAME;
    };
    for (size_t heard = 1600;; heard += 1600) {
        heard = std::min(heard, audio.size());
        for (; (loud.size() + 1) * FRAME <= heard;) {
            double sum = 0;
            for (size_t i = loud.size() * FRAME, end = i + FRAME; i < end; i++) sum += audio[i] * audio[i];
            loud.push_back((float)std::sqrt(sum / FRAME));
            top = std::max(top, loud.back());
            look(loud.size() - 1);
        }
        size_t cut = 0;
        if (!whole && heard - begun >= LONGEST) {
            size_t at = loud.size() - 1;
            for (size_t f = loud.size() - 150; f < loud.size(); f++) if (loud[f] < loud[at]) at = f;
            cut = at * FRAME;
        } else if (!whole && heard - begun >= STRETCH) {
            bool pause = true;
            for (size_t f = loud.size() - PAUSE; f < loud.size(); f++) pause = pause && under(f, 0.1f);
            if (pause) cut = (loud.size() - PAUSE / 2) * FRAME;
        }
        if (cut > begun) {
            if (first < cut) parts.push_back({begun, cut, std::min(speech, cut)});
            begun = cut, first = speech = SIZE_MAX;
            for (size_t f = cut / FRAME; f < loud.size(); f++) look(f);
        }
        if (heard == audio.size()) break;
    }
    if (whole) parts.push_back({0, audio.size(), 0});
    else if (first != SIZE_MAX) parts.push_back({begun, audio.size(), std::min(speech, audio.size())});

    for (auto &p : parts) {
        printf("{\"from\":%.2f,\"to\":%.2f,\"lead\":%.2f", p.from / (double)RATE, p.to / (double)RATE, (p.speech - p.from) / (double)RATE);
        for (int seconds : {2, 3, 4, 5, 0}) {
            std::vector<float> odds(whisper_lang_max_id() + 1, 0.f);
            const size_t from = seconds ? p.speech : p.from, n = seconds ? std::min(p.to - from, (size_t)seconds * RATE) : p.to - from;
            const int most = n && whisper_pcm_to_mel(ctx, audio.data() + from, (int)n, threads) == 0 ? whisper_lang_auto_detect(ctx, 0, threads, odds.data()) : -1;
            printf(",\"p%d\":{\"de\":%.6g,\"en\":%.6g,\"top\":\"%s\"}", seconds, odds[whisper_lang_id("de")], odds[whisper_lang_id("en")], most < 0 ? "" : whisper_lang_str(most));
        }
        for (int i = 3; i < argc; i++) {
            whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_BEAM_SEARCH);   // as engine.cpp asks
            params.n_threads = threads;
            params.language = argv[i];
            params.no_context = params.no_timestamps = params.single_segment = params.suppress_nst = true;
            params.print_progress = params.print_realtime = params.print_timestamps = params.print_special = false;
            if (prompt && *prompt) params.initial_prompt = prompt;
            if (tinc) params.temperature_inc = (float)atof(tinc);
            std::vector<float> part(audio.begin() + p.from, audio.begin() + p.to);
            if (part.size() < (size_t)RATE + 1600) part.resize(RATE + 1600, 0.f);
            std::string heard;
            if (whisper_full(ctx, params, part.data(), (int)part.size()) == 0)
                for (int s = 0; s < whisper_full_n_segments(ctx); s++) heard += whisper_full_get_segment_text(ctx, s);
            printf(",\"%s\":\"%s\"", argv[i], quoted(heard).c_str());
        }
        printf("}\n");
        fflush(stdout);
    }
    _exit(0);
}
