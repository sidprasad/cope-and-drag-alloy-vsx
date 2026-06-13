package org.alloytools.cnd;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import edu.mit.csail.sdg.alloy4.A4Reporter;
import edu.mit.csail.sdg.alloy4.Err;
import edu.mit.csail.sdg.alloy4.ErrorWarning;
import edu.mit.csail.sdg.alloy4.Pos;
import edu.mit.csail.sdg.ast.Command;
import edu.mit.csail.sdg.ast.Expr;
import edu.mit.csail.sdg.ast.ExprVar;
import edu.mit.csail.sdg.parser.CompModule;
import edu.mit.csail.sdg.parser.CompUtil;
import edu.mit.csail.sdg.translator.A4Options;
import edu.mit.csail.sdg.translator.A4Solution;
import edu.mit.csail.sdg.translator.A4SolutionWriter;
import edu.mit.csail.sdg.translator.TranslateAlloyToKodkod;

/**
 * A tiny line-based JSON socket bridge that drives the (mainline) Alloy Analyzer for Cope and Drag.
 *
 * Launched as: {@code java -cp <alloy.jar>:cnd-alloy-server.jar org.alloytools.cnd.CnDServer <port> <file.als>}
 * It prints {@code CND_PORT=<port>} on stdout once listening, then accepts one client and speaks
 * one JSON request per line / one JSON response per line:
 *
 *   {"op":"list"}                          -> {"ok":true,"commands":["run$1", ...]}
 *   {"op":"run","index":0}                 -> {"ok":true,"command":"run$1","xml":"<alloy>...</alloy>"}
 *   {"op":"next"}                          -> {"ok":true,"xml":"...","temporal":<bool>}             (alias for fork -3)
 *   {"op":"fork","state":-1}               -> {"ok":true,"xml":"...","temporal":<bool>}  | {"ok":false,"error":"..."}
 *   {"op":"eval","expr":"Node","state":0}  -> {"ok":true,"result":"{Node$0}"}    | {"ok":false,"error":"..."}
 *
 * `temporal` is the model's A4Solution.isTemporal() (it tracks the model, not the op or fork state).
 *
 * `fork.state` is the arg to Alloy's {@link A4Solution#fork(int)} — the single primitive behind all
 * of the Analyzer's trace-navigation buttons: -3 = "New Trace" (== next()), -1 = "New Config",
 * 0 = "New Init", n>=0 = "New Fork" at trace state n. The extension currently wires only -3/-1/0
 * (it has no displayed-state index to drive "New Fork"). Responses carry `temporal` so the caller
 * can surface the config/init variants only for traces.
 *
 * Instances, enumeration (next), and evaluation all use Alloy's own API, so behaviour matches the
 * analyzer exactly. The Node "Sterling provider" in the VS Code extension translates between this
 * socket and the Sterling websocket protocol Cope and Drag speaks.
 */
public class CnDServer {

    private final String filename;
    private final A4Options opt = new A4Options();
    private final A4Reporter rep = new A4Reporter();
    private final Gson gson = new Gson();

    // `world` is the module that produced `current`: they are set together on a successful run and
    // `eval` parses expressions against `world` while evaluating them on `current`, so the two must
    // never drift. Only doRun touches `world`; listing parses into a throwaway so a metadata refresh
    // can't repoint eval at a newer file than the instance on screen.
    private CompModule world;
    private A4Solution current;

    public CnDServer(String filename) {
        this.filename = filename;
        // A4Options.solver defaults to SATFactory.DEFAULT (SAT4J): pure-Java, no native libs,
        // and supports solution enumeration — exactly what we need.
        // The instance XML's `filename` attribute comes from this; Cope and Drag requires it.
        opt.originalFilename = new File(filename).getAbsolutePath();
    }

    public static void main(String[] args) throws Exception {
        // One-shot parse/type-check for diagnostics: `CnDServer check <file.als>` -> JSON on stdout.
        if (args.length >= 2 && args[0].equals("check")) {
            System.out.println(new CnDServer(args[1]).doCheck());
            return;
        }
        if (args.length < 2) {
            System.err.println("usage: CnDServer <port> <file.als>   (port 0 = auto)  |  CnDServer check <file.als>");
            System.exit(2);
        }
        new CnDServer(args[1]).serve(Integer.parseInt(args[0]));
    }

    /**
     * Parse + type-check the file with Alloy's own compiler and return its errors/warnings (with
     * 0-based positions) as JSON: {"diagnostics":[{line,col,endLine,endCol,message,severity}]}.
     * Alloy throws on the first error, so at most one "error" is reported per check, plus any
     * warnings the compiler collected.
     */
    String doCheck() {
        JsonArray diags = new JsonArray();
        final List<ErrorWarning> warnings = new ArrayList<>();
        A4Reporter reporter = new A4Reporter() {
            @Override
            public void warning(ErrorWarning w) {
                warnings.add(w);
            }
        };
        try {
            CompUtil.parseEverything_fromFile(reporter, new HashMap<String, String>(), filename);
        } catch (Err e) {
            diags.add(diag(e.pos, e.msg, "error"));
        } catch (Throwable t) {
            diags.add(diag(Pos.UNKNOWN, t.getMessage() == null ? t.toString() : t.getMessage(), "error"));
        }
        for (ErrorWarning w : warnings) diags.add(diag(w.pos, w.msg, "warning"));
        JsonObject r = new JsonObject();
        r.add("diagnostics", diags);
        return gson.toJson(r);
    }

    /** A diagnostic with a 0-based range, defaulting to the file start when the position is unknown. */
    private JsonObject diag(Pos pos, String message, String severity) {
        boolean known = pos != null && !Pos.UNKNOWN.equals(pos) && pos.y > 0;
        JsonObject d = new JsonObject();
        d.addProperty("line", known ? pos.y - 1 : 0);
        d.addProperty("col", known ? Math.max(0, pos.x - 1) : 0);
        d.addProperty("endLine", known ? pos.y2 - 1 : 0);
        d.addProperty("endCol", known ? pos.x2 : 1);
        d.addProperty("message", message == null ? "error" : message.trim());
        d.addProperty("severity", severity);
        return d;
    }

    private void serve(int port) throws Exception {
        try (ServerSocket server = new ServerSocket(port, 1, InetAddress.getByName("127.0.0.1"))) {
            // The launcher reads this line to learn the actual port (when port 0 was requested).
            System.out.println("CND_PORT=" + server.getLocalPort());
            System.out.flush();
            try (Socket sock = server.accept();
                    BufferedReader in = new BufferedReader(new InputStreamReader(sock.getInputStream(), "UTF-8"));
                    PrintWriter out = new PrintWriter(new OutputStreamWriter(sock.getOutputStream(), "UTF-8"), true)) {
                String line;
                while ((line = in.readLine()) != null) {
                    if (line.trim().isEmpty()) continue;
                    out.println(handle(line));
                }
            }
        }
    }

    private synchronized String handle(String line) {
        try {
            JsonObject req = JsonParser.parseString(line).getAsJsonObject();
            String op = req.get("op").getAsString();
            switch (op) {
                case "list":   return doList();
                case "run":    return doRun(req.has("index") ? req.get("index").getAsInt() : 0);
                case "next":   return doFork(-3); // "New Trace": A4Solution.next() is literally fork(-3).
                case "fork":   return doFork(req.has("state") ? req.get("state").getAsInt() : -3);
                case "eval":   return doEval(req.get("expr").getAsString(),
                                             req.has("state") ? req.get("state").getAsInt() : 0);
                default:       return err("Unknown op: " + op);
            }
        } catch (Throwable t) {
            return err(t.getMessage() == null ? t.toString() : t.getMessage());
        }
    }

    private String doList() throws Exception {
        // Parse into a local module to enumerate commands. The extension calls list on every connect
        // and meta refresh, not just before a run, so this must NOT touch `world`: doing so would
        // repoint a later eval at this file version while `current` still holds the displayed instance.
        CompModule w = reparse();
        JsonArray arr = new JsonArray();
        for (Command c : w.getAllCommands()) arr.add(c.label);
        JsonObject r = ok();
        r.add("commands", arr);
        return gson.toJson(r);
    }

    private String doRun(int index) throws Exception {
        // A rerun invalidates whatever was on screen, so drop the active solution before reparsing.
        // If the edited file no longer parses, has no commands, or is unsatisfiable, we bail out with
        // `current` already cleared, so next/eval can't keep enumerating the previous (stale) model.
        current = null;
        world = null;
        CompModule w = reparse();
        List<Command> commands = w.getAllCommands();
        if (commands.isEmpty()) return err("This model has no commands to run.");
        if (index < 0 || index >= commands.size()) index = 0;
        Command c = commands.get(index);
        A4Solution sol = TranslateAlloyToKodkod.execute_commandFromBook(rep, w.getAllReachableSigs(), c, opt);
        if (sol == null || !sol.satisfiable())
            return err("No instance found" + (c.check ? " (no counterexample)." : " (unsatisfiable)."));
        // Pair the solved module with its solution only now that the run succeeded.
        world = w;
        current = sol;
        return instanceJson(c.label);
    }

    /**
     * Enumerate via Alloy's own {@link A4Solution#fork(int)} — the single primitive behind every
     * trace-navigation button in the Alloy Analyzer:
     *   -3 = next / "New Trace" (A4Solution.next() is literally fork(-3))
     *   -1 = "New Config"   0 = "New Init"   n>=0 = "New Fork" (a new trace agreeing up to state n)
     * The config/init variants are only meaningful for temporal models; the extension surfaces those
     * buttons only for traces (gated on the `temporal` flag in instanceJson). The n>=0 "New Fork"
     * case stays supported here as a generic primitive even though no button currently drives it.
     */
    private String doFork(int state) throws Exception {
        if (current == null) return err("Run a command before asking for the next instance.");
        if (!current.isIncremental()) return err("This solution cannot be enumerated.");
        A4Solution next = current.fork(state);
        if (next == null || !next.satisfiable()) return err("There are no more satisfying instances.");
        current = next;
        return instanceJson(null);
    }

    /**
     * Standard instance response. For temporal models the XML already contains the full trace (all
     * states + loopback metadata), so Cope and Drag handles stepping through states itself. The
     * `temporal` flag lets the extension show the trace-only nav buttons (config/init/fork) just for
     * traces, while plain "Next" (fork -3) stays available for every model.
     */
    private String instanceJson(String command) throws Exception {
        JsonObject r = ok();
        if (command != null) r.addProperty("command", command);
        r.addProperty("xml", toXML(current));
        r.addProperty("temporal", current.isTemporal());
        return gson.toJson(r);
    }

    private String doEval(String expr, int state) throws Exception {
        if (current == null) return err("Run a command before evaluating.");
        // Mirror Alloy's evaluator: expose the instance's atoms/skolems as globals, then parse + eval.
        world.clearGlobals();
        for (ExprVar a : current.getAllAtoms()) world.addGlobal(a.label, a);
        for (ExprVar a : current.getAllSkolems()) world.addGlobal(a.label, a);
        Expr e = world.parseOneExpressionFromString(expr);
        Object value = current.eval(e, state);
        JsonObject r = ok();
        r.addProperty("result", value == null ? "" : value.toString());
        return gson.toJson(r);
    }

    /**
     * Parse the model from disk, returning a fresh module. Called before every list/run so edits to
     * the .als are picked up: the extension keeps one CnDServer alive per file across runs, so a
     * parse-once cache would pin the model to its first version and re-runs would silently replay the
     * stale spec. Parsing is cheap next to solving. Callers decide whether the result becomes the
     * `world` paired with `current` (doRun, on success) or is used and discarded (doList).
     */
    private CompModule reparse() throws Exception {
        return CompUtil.parseEverything_fromFile(rep, new HashMap<String, String>(), filename);
    }

    private String toXML(A4Solution sol) throws Exception {
        StringWriter sw = new StringWriter();
        try (PrintWriter pw = new PrintWriter(sw)) {
            A4SolutionWriter.writeInstance(null, sol, pw, Collections.emptyList(), Collections.emptyMap());
        }
        String xml = sw.toString();
        // Cope and Drag recognizes a temporal trace by a `backloop` attribute (the loop-back state
        // index) on <instance>; Alloy writes `looplength` instead, which CnD ignores. Add `backloop`
        // (= getLoopState() = tracelength - looplength) to every state so CnD renders the trace and
        // shows its time stepper. Only for temporal solutions (static instances are not traces).
        if (sol.isTemporal()) {
            xml = xml.replace("<instance ", "<instance backloop=\"" + sol.getLoopState() + "\" ");
        }
        return xml;
    }

    private JsonObject ok() {
        JsonObject r = new JsonObject();
        r.addProperty("ok", true);
        return r;
    }

    private String err(String msg) {
        JsonObject r = new JsonObject();
        r.addProperty("ok", false);
        r.addProperty("error", msg == null ? "error" : msg.trim());
        return gson.toJson(r);
    }
}
