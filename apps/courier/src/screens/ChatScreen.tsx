import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, TextInput, Pressable, FlatList, Image, StyleSheet,
  KeyboardAvoidingView, Platform, Alert, ScrollView,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { api, uploadImage, chatSocketUrl, ApiError, type ChatMessage } from "../lib/api";
import type { ScreenProps } from "../lib/navigation";

const theme = {
  bg: "#14201B", surface: "#1D2C26", text: "#F4F7F5",
  muted: "#93A39C", accent: "#3FBF8F",
};

/**
 * Courier-side chat.
 *
 * The courier is on a bike, often in the rain, sometimes holding a bag. Quick
 * replies come first and are large; free typing is the fallback, not the
 * default. The proof-of-delivery photo is the highest-value action on the
 * screen, so it gets its own labelled button rather than a small icon.
 */
export function ChatScreen({ route }: ScreenProps<"Chat">) {
  const { orderId } = route.params;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [quickReplies, setQuickReplies] = useState<string[]>([]);
  const [closed, setClosed] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<FlatList<ChatMessage> | null>(null);

  const load = useCallback(async () => {
    try {
      const thread = await api.chat(orderId);
      setMessages(thread.messages);
      setQuickReplies(thread.quickReplies);
      setClosed(thread.closed);
    } catch {
      // The poll retries.
    }
  }, [orderId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    try {
      socket = new WebSocket(chatSocketUrl(orderId));
      socket.onmessage = (event) => {
        const payload = JSON.parse(String(event.data)) as { type: string; message: ChatMessage };
        if (payload.type !== "message") return;
        setMessages((prev) =>
          prev.some((m) => m.id === payload.message.id) ? prev : [...prev, payload.message],
        );
      };
    } catch {
      socket = null;
    }
    const poll = setInterval(load, 15_000);
    return () => { socket?.close(); clearInterval(poll); };
  }, [orderId, load]);

  async function send(body: string, kind: "TEXT" | "QUICK_REPLY" = "TEXT") {
    if (!body.trim() || busy) return;
    setBusy(true);
    setDraft("");
    try {
      const message = await api.sendMessage(orderId, { kind, body: body.trim() });
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
    } catch (e) {
      setDraft(body);
      Alert.alert("Nicht gesendet", e instanceof ApiError ? e.message : "Erneut versuchen.");
    } finally {
      setBusy(false);
    }
  }

  async function sendPhoto() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Kamera nötig", "Ohne Kamerafreigabe kannst du kein Ablagefoto senden.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      quality: 0.5,
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
    });
    if (result.canceled || !result.assets[0]) return;

    setBusy(true);
    try {
      const uploaded = await uploadImage(result.assets[0].uri, result.assets[0].mimeType ?? "image/jpeg");
      const message = await api.sendMessage(orderId, { mediaId: uploaded.mediaId });
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
    } catch (e) {
      Alert.alert("Foto nicht gesendet", e instanceof ApiError ? e.message : "Erneut versuchen.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={90}
    >
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.list}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        renderItem={({ item }) => {
          const mine = item.sender === "COURIER";
          return (
            <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
              {item.mediaUrl ? (
                <Image source={{ uri: item.mediaUrl }} style={styles.image} resizeMode="cover" />
              ) : null}
              {item.body ? <Text style={styles.bubbleText}>{item.body}</Text> : null}
            </View>
          );
        }}
        ListEmptyComponent={
          <Text style={styles.empty}>
            Der Kunde sieht deine Nummer nicht — schreib hier.
          </Text>
        }
      />

      {closed ? (
        <Text style={styles.closed}>Chat geschlossen.</Text>
      ) : (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.quickRow} contentContainerStyle={styles.quickContent}>
            {quickReplies.map((reply) => (
              <Pressable key={reply} style={styles.quickChip} onPress={() => send(reply, "QUICK_REPLY")}>
                <Text style={styles.quickText}>{reply}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <Pressable style={styles.photoButton} onPress={sendPhoto} disabled={busy}>
            <Text style={styles.photoText}>Ablagefoto senden</Text>
          </Pressable>

          <View style={styles.composer}>
            <TextInput
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              placeholder="Nachricht"
              placeholderTextColor={theme.muted}
              multiline
              maxLength={1000}
            />
            <Pressable
              style={[styles.send, (!draft.trim() || busy) && styles.sendDisabled]}
              onPress={() => send(draft)}
              disabled={!draft.trim() || busy}
            >
              <Text style={styles.sendText}>Senden</Text>
            </Pressable>
          </View>
        </>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  list: { padding: 16, gap: 8 },
  bubble: { maxWidth: "82%", borderRadius: 14, padding: 12 },
  mine: { alignSelf: "flex-end", backgroundColor: theme.accent },
  theirs: { alignSelf: "flex-start", backgroundColor: theme.surface },
  bubbleText: { color: theme.text, fontSize: 15, lineHeight: 21 },
  image: { width: 200, height: 150, borderRadius: 8, marginBottom: 6 },
  empty: { color: theme.muted, textAlign: "center", marginTop: 40, paddingHorizontal: 24, lineHeight: 20 },
  quickRow: { flexGrow: 0 },
  quickContent: { padding: 10, gap: 8 },
  quickChip: { backgroundColor: theme.surface, paddingHorizontal: 16, paddingVertical: 14, borderRadius: 999 },
  quickText: { color: theme.text, fontSize: 15 },
  photoButton: {
    marginHorizontal: 12, marginBottom: 8,
    backgroundColor: theme.surface, borderRadius: 12,
    paddingVertical: 16, alignItems: "center",
  },
  photoText: { color: theme.text, fontSize: 16, fontWeight: "600" },
  composer: { flexDirection: "row", gap: 8, padding: 12, alignItems: "flex-end" },
  input: {
    flex: 1, maxHeight: 110, minHeight: 48,
    backgroundColor: theme.surface, borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 12, color: theme.text, fontSize: 15,
  },
  send: { backgroundColor: theme.accent, borderRadius: 12, paddingHorizontal: 20, height: 48, justifyContent: "center" },
  sendDisabled: { opacity: 0.4 },
  sendText: { color: "#0B1512", fontWeight: "700" },
  closed: { color: theme.muted, textAlign: "center", padding: 20 },
});
