import com.google.gson.*;
import dk.dma.ais.message.AisMessage;
import dk.dma.ais.packet.AisPacket;
import dk.dma.ais.packet.AisPacketParser;
import java.io.*;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.*;

public class AisBridge {
    private static final Gson JSON = new Gson();

    private static Object getter(Object object, String method) throws Exception {
        Method selected;
        try { selected = object.getClass().getMethod(method); }
        catch (NoSuchMethodException absent) { return null; }
        return selected.invoke(object);
    }

    private static Double number(Object object, String method) throws Exception {
        Object value = getter(object, method);
        return value instanceof Number ? ((Number) value).doubleValue() : null;
    }

    public static void main(String[] args) throws Exception {
        JsonObject input = JSON.fromJson(new InputStreamReader(System.in, StandardCharsets.UTF_8), JsonObject.class);
        JsonArray rows = input.getAsJsonArray("rows");
        Map<String, AisPacketParser> parsers = new HashMap<>();
        Map<String, Integer> pending = new HashMap<>();
        Map<String, Map<String, Object>> staticByShip = new HashMap<>();
        List<Map<String, Object>> output = new ArrayList<>();
        List<Map<String, Object>> staticReports = new ArrayList<>();
        List<Map<String, Object>> errors = new ArrayList<>();
        int packets = 0, invalidPositions = 0, nonPosition = 0, discardedFragments = 0;
        for (int index = 0; index < rows.size(); index++) {
            JsonObject row = rows.get(index).getAsJsonObject();
            String source = row.get("source_id").getAsString();
            AisPacketParser parser = parsers.computeIfAbsent(source, key -> new AisPacketParser());
            try {
                // 仅拆分存储时拼接的完整句子；校验、组包和 AIS 字段解码全部交给现有库。
                String[] lines = row.get("message").getAsString().split("(?:\\r?\\n|(?<=\\*[0-9A-Fa-f]{2})(?=[!$]))");
                for (String line : lines) {
                    if (line.trim().isEmpty()) continue;
                    AisPacket packet = parser.readLine(line.trim());
                    if (packet == null) {
                        if (line.contains("VDM,") || line.contains("VDO,")) pending.put(source, pending.getOrDefault(source, 0) + 1);
                        continue;
                    }
                    // 库可能在新的句组到达时放弃旧片段，明确记录未被完整包消耗的片段。
                    discardedFragments += Math.max(0, pending.getOrDefault(source, 0) - (packet.getVdm().getTotal() - 1));
                    pending.put(source, 0);
                    AisMessage message = packet.getAisMessage();
                    packets++;
                    String mmsi = String.format(Locale.ROOT, "%09d", message.getUserId());
                    String shipKey = source + ":" + mmsi;
                    Double bow = number(message, "getDimBow");
                    Double stern = number(message, "getDimStern");
                    Double port = number(message, "getDimPort");
                    Double starboard = number(message, "getDimStarboard");
                    if (bow != null && stern != null && port != null && starboard != null && bow + stern > 0 && port + starboard > 0) {
                        Map<String, Object> dims = new LinkedHashMap<>();
                        dims.put("bow", bow); dims.put("stern", stern); dims.put("port", port); dims.put("starboard", starboard);
                        dims.put("rowIndex", index);
                        staticByShip.put(shipKey, dims);
                        Map<String, Object> report = new LinkedHashMap<>();
                        report.put("rowIndex", index); report.put("mmsi", mmsi);
                        report.put("messageType", Integer.toString(message.getMsgId())); report.put("dimensions", dims);
                        staticReports.add(report);
                    }
                    int type = message.getMsgId();
                    if (!(type == 1 || type == 2 || type == 3 || type == 18)) { nonPosition++; continue; }
                    Object position = getter(message, "getPos");
                    Double lng = position == null ? null : number(position, "getLongitudeDouble");
                    Double lat = position == null ? null : number(position, "getLatitudeDouble");
                    if (lng == null || lat == null || !Double.isFinite(lng) || !Double.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) { invalidPositions++; continue; }
                    Map<String, Object> point = new LinkedHashMap<>();
                    point.put("rowIndex", index); point.put("mmsi", mmsi); point.put("messageType", Integer.toString(type));
                    point.put("position", new double[]{lng, lat});
                    Double sog = number(message, "getSog"); Double cog = number(message, "getCog");
                    point.put("sogKnots", sog == null ? null : sog / 10.0);
                    point.put("cogDeg", cog == null ? null : cog / 10.0);
                    point.put("headingDeg", number(message, "getTrueHeading"));
                    point.put("accuracyBit", number(message, "getPosAcc"));
                    if (staticByShip.containsKey(shipKey)) point.put("dimensions", staticByShip.get(shipKey));
                    output.add(point);
                }
            } catch (Exception error) {
                Map<String, Object> detail = new LinkedHashMap<>(); detail.put("rowIndex", index); detail.put("type", error.getClass().getSimpleName()); errors.add(detail);
                parsers.put(source, new AisPacketParser()); pending.put(source, 0);
            }
        }
        Map<String, Object> stats = new LinkedHashMap<>();
        stats.put("rawReports", rows.size()); stats.put("decodedPackets", packets); stats.put("failedReports", errors.size());
        stats.put("pendingFragments", pending.values().stream().mapToInt(Integer::intValue).sum());
        stats.put("discardedFragments", discardedFragments);
        stats.put("nonPositionReports", nonPosition); stats.put("invalidPositions", invalidPositions);
        Map<String, Object> result = new LinkedHashMap<>(); result.put("observations", output); result.put("parseStats", stats); result.put("errors", errors);
        result.put("staticReports", staticReports);
        System.out.println(JSON.toJson(result));
    }
}
