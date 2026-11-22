//! The weights (a ladder for each agent, `agent_weights`): what each agent
//! that takes a model and an effort is started with at each weight, that an
//! empty ladder changes nothing, that the person's own command wins, and
//! that a continued session gets nothing added. One test sets the person's
//! commands, which the core keeps once for the whole process.

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use tasktap_core::agents::{self, Agent, Run};
use tasktap_proto::{AgentCommand, AgentWeight, SessionId, Weight};

/// The person's commands are the core's, once for the process: the tests take turns.
fn one() -> MutexGuard<'static, ()> {
    static ONE: Mutex<()> = Mutex::new(());
    ONE.lock().unwrap_or_else(|e| e.into_inner())
}

fn line(agent: &str, weight: Weight, model: &str, effort: &str) -> AgentWeight {
    AgentWeight {
        agent: agent.into(),
        weight,
        model: model.into(),
        effort: effort.into(),
    }
}

fn ladder(agent: &str) -> Vec<AgentWeight> {
    vec![
        line(agent, Weight::Light, "small", "low"),
        line(agent, Weight::Heavy, "big", "high"),
    ]
}

fn agent(id: &str) -> &'static dyn Agent {
    agents::find(id).unwrap()
}

/// The arguments a new run of `agent` is started with at `weight` on `ladder`,
/// or a continued one (`resume`).
fn argv(
    agent: &dyn Agent,
    weight: Weight,
    ladder: &[AgentWeight],
    resume: Option<&str>,
) -> Vec<String> {
    let (model, effort) = agents::weighed(agent, weight, ladder);
    let theirs = agents::command(agent);
    let run = Run {
        session: SessionId::try_from(
            "01930000-0000-7000-8000-0000000000aa"
                .parse::<tasktap_proto::Uuid>()
                .unwrap(),
        )
        .unwrap(),
        cwd: Path::new("/tmp/project"),
        prompt: "fix the build",
        words: None,
        model: model.as_deref(),
        effort: effort.as_deref(),
        resume,
        hook: Path::new("/opt/tasktap/tasktap"),
        home: Path::new("/data/agents/x"),
        allowed: &[],
        args: agents::theirs(agent.program(), &theirs),
    };
    agent.launch(&run)
}

fn has(argv: &[String], words: &[&str]) -> bool {
    (argv.windows(words.len())).any(|w| w.iter().zip(words).all(|(a, b)| a == b))
}

#[test]
fn each_agent_is_started_with_its_weights_model_and_effort() {
    let _one = one();
    for (id, effort) in [
        ("claude", Some(["--effort", "low"])),
        ("codex", Some(["-c", "model_reasoning_effort=\"low\""])),
        ("pi", Some(["--thinking", "low"])),
        ("copilot", Some(["--reasoning-effort", "low"])),
        ("agy", None),
    ] {
        let a = agent(id);
        let light = argv(a, Weight::Light, &ladder(id), None);
        assert!(has(&light, &["--model", "small"]), "{id} {light:?}");
        assert_eq!(
            effort.is_some_and(|e| has(&light, &e)),
            effort.is_some(),
            "{id} {light:?}"
        );
        assert!(
            !light.iter().any(|w| w == "big" || w == "high"),
            "{id} {light:?}"
        );
        let heavy = argv(a, Weight::Heavy, &ladder(id), None);
        assert!(has(&heavy, &["--model", "big"]), "{id} {heavy:?}");
        // The weight with no line is the agent's own.
        let standard = argv(a, Weight::Standard, &ladder(id), None);
        assert_eq!(standard, argv(a, Weight::Standard, &[], None), "{id}");
        // Where Tasktap does not know how to pass an effort, it passes none.
        assert_eq!(
            a.weights().unwrap().effort.is_empty(),
            effort.is_none(),
            "{id}"
        );
    }
}

#[test]
fn an_empty_ladder_changes_nothing_byte_for_byte() {
    let _one = one();
    for id in ["claude", "codex", "pi", "copilot", "agy"] {
        let a = agent(id);
        let own = argv(a, Weight::Heavy, &[], None);
        for empty in [
            vec![line(id, Weight::Heavy, "", "")],
            vec![line("other", Weight::Heavy, "big", "high")],
        ] {
            assert_eq!(argv(a, Weight::Heavy, &empty, None), own, "{id}");
        }
        assert!(
            !own.iter().any(|w| w.contains("model") || w == "--effort"),
            "{id} {own:?}"
        );
    }
}

#[test]
fn an_agent_tasktap_does_not_know_gets_nothing() {
    let _one = one();
    for id in ["opencode", "aider"] {
        let a = agent(id);
        assert!(a.weights().is_none(), "{id}");
        assert_eq!(
            agents::weighed(a, Weight::Heavy, &ladder(id)),
            (None, None),
            "{id}"
        );
    }
}

#[test]
fn a_continued_session_gets_nothing_added() {
    let _one = one();
    for id in ["claude", "codex"] {
        let argv = argv(
            agent(id),
            Weight::Heavy,
            &ladder(id),
            Some("conversation-1"),
        );
        assert!(
            !has(&argv, &["--model", "big"]) && !argv.iter().any(|w| w == "--effort"),
            "{id} {argv:?}"
        );
        assert!(
            !argv.iter().any(|w| w.contains("model_reasoning_effort")),
            "{id} {argv:?}"
        );
    }
}

#[test]
fn the_persons_own_command_that_names_a_model_wins() {
    let _one = one();
    let set = |id: &str, command: &str| {
        agents::set_commands(&[AgentCommand {
            agent: id.into(),
            command: command.into(),
        }]);
        assert_eq!(agents::command_refused(agent(id)), None, "{command}");
    };
    let high = Some("high".to_owned());
    set("claude", "caffeinate -i claude --model opus");
    // The model is theirs; the effort, which they did not name, is the ladder's.
    assert_eq!(
        agents::weighed(agent("claude"), Weight::Heavy, &ladder("claude")),
        (None, high.clone())
    );
    set("claude", "claude --effort max");
    assert_eq!(
        agents::weighed(agent("claude"), Weight::Heavy, &ladder("claude")),
        (Some("big".into()), None)
    );
    set("codex", "codex -c model=o3 -c model_reasoning_effort=high");
    assert_eq!(
        agents::weighed(agent("codex"), Weight::Heavy, &ladder("codex")),
        (None, None)
    );
    set("codex", "codex -m o3");
    assert_eq!(
        agents::weighed(agent("codex"), Weight::Heavy, &ladder("codex")),
        (None, high.clone())
    );
    agents::set_commands(&[]);
    // Another agent's command says nothing of this one.
    assert_eq!(
        agents::weighed(agent("pi"), Weight::Heavy, &ladder("pi")),
        (Some("big".into()), high)
    );
}

#[test]
fn a_ladder_is_kept_only_as_an_agent_can_use_it() {
    let _one = one();
    assert_eq!(agents::check_weights(&ladder("claude")), Ok(()));
    for (list, why) in [
        (
            vec![line("opencode", Weight::Light, "x", "")],
            "does not pass a model",
        ),
        (
            vec![line("agy", Weight::Light, "x", "low")],
            "does not pass an effort",
        ),
        (
            vec![line("claude", Weight::Light, "-x", "")],
            "not starting with -",
        ),
        (
            vec![line("claude", Weight::Light, "x\ny", "")],
            "none a control",
        ),
        (
            vec![
                line("claude", Weight::Light, "x", ""),
                line("claude", Weight::Light, "y", ""),
            ],
            "two lines",
        ),
    ] {
        assert!(
            agents::check_weights(&list).unwrap_err().contains(why),
            "{list:?}"
        );
    }
}
