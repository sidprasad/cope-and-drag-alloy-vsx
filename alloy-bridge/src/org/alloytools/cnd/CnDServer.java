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
 *   {"op":"next"}                          -> {"ok":true,"xml":"..."}            | {"ok":false,"error":"..."}
 *   {"op":"eval","expr":"Node","state":0}  -> {"ok":true,"result":"{Node$0}"}    | {"ok":false,"error":"..."}
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
                case "next":   return doNext();
                case "eval":   return doEval(req.get("expr").getAsString(),
                                             req.has("state") ? req.get("state").getAsInt() : 0);
                default:       return err("Unknown op: " + op);
            }
        } catch (Throwable t) {
            return err(t.getMessage() == null ? t.toString() : t.getMessage());
        }
    }

    private String doList() throws Exception {
        ensureParsed();
        JsonArray arr = new JsonArray();
        for (Command c : world.getAllCommands()) arr.add(c.label);
        JsonObject r = ok();
        r.add("commands", arr);
        return gson.toJson(r);
    }

    private String doRun(int index) throws Exception {
        ensureParsed();
        List<Command> commands = world.getAllCommands();
        if (commands.isEmpty()) return err("This model has no commands to run.");
        if (index < 0 || index >= commands.size()) index = 0;
        Command c = commands.get(index);
        current = TranslateAlloyToKodkod.execute_commandFromBook(rep, world.getAllReachableSigs(), c, opt);
        if (current == null || !current.satisfiable())
            return err("No instance found" + (c.check ? " (no counterexample)." : " (unsatisfiable)."));
        return instanceJson(c.label);
    }

    private String doNext() throws Exception {
        if (current == null) return err("Run a command before asking for the next instance.");
        if (!current.isIncremental()) return err("This solution cannot be enumerated.");
        A4Solution next = current.next();
        if (next == null || !next.satisfiable()) return err("There are no more satisfying instances.");
        current = next;
        return instanceJson(null);
    }

    /**
     * Standard instance response. For temporal models the XML already contains the full trace (all
     * states + loopback metadata), so Cope and Drag handles stepping through states itself.
     */
    private String instanceJson(String command) throws Exception {
        JsonObject r = ok();
        if (command != null) r.addProperty("command", command);
        r.addProperty("xml", toXML(current));
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

    private void ensureParsed() throws Exception {
        if (world == null)
            world = CompUtil.parseEverything_fromFile(rep, new HashMap<String, String>(), filename);
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
