import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, TextInput, Pressable, FlatList, Image, StyleSheet,
  KeyboardAvoidingView, Platform, ActivityIndicator, Alert, ScrollView,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { theme } from "../lib/theme";
import { api, uploadImage, chatSocketUrl, ApiError, type ChatMessage } from "../lib/api";
import type { ScreenProps } from "../lib/navigation";

/**
 * Order chat.
 *
 * Neither side ever sees the other's phone number — the thread is the channel.
 * Photos matter more than text here ("it's behind the blue bin"), so the camera
 * is a first-class button rather than buried behind an attachment menu.
 *
 * A socket carries new messages, with a poll as the fallback: mobile networks
 * drop sockets constantly and a chat that silently stops updating is worse than
 * one that was never live.
 */
export function ChatScreen({ route }: ScreenProps<"Chat">) {
  const { orderId } = route.params;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [quickReplies, setQuickReplies] = useState<string[]>([]);
  const [closed, setClosed] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const listRef = useRef<FlatList<ChatMessage> | null>(null);

  const load = useCallback(async () => {
    try {
      const thread = await api.chat(orderId);
      setMessages(thread.messages);
      setQuickReplies(thread.quickReplies);
      setClosed(thread.closed);
    } catch {
      // Fall through — the poll retries.
    } finally {
      setLoading(false);
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
        // The sender already appended optimistically; don't double it.
        setMessages((prev) =>
          prev.some((m) => m.id === payload.message.id) ? prev : [...prev, payload.message],
        );
      };
    } catch {
      socket = null;
    }

    // Cheap safety net for a dropped socket. Slow enough not to matter when the
    // socket is healthy.
    const poll = setInterval(load, 15_000);
    return () => {
      socket?.close();
      clearInterval(poll);
    };
  }, [orderId, load]);

  async function send(body: string, kind: "TEXT" | "QUICK_REPLY" = "TEXT") {
    if (!body.trim() || sending) return;
    setSending(true);
    setDraft("");
    try {
      const message = await api.sendMessage(orderId, { kind, body: body.trim() });
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
    } catch (e) {
      setDraft(body);
      Alert.alert("Nicht gesendet", e instanceof ApiError ? e.message : "Bitte erneut versuchen.");
    } finally {
      setSending(false);
    }
  }

  async function sendPhoto(fromCamera: boolean) {
    const permission = fromCamera
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Zugriff nötig", "Ohne Freigabe können wir kein Foto senden.");
      return;
    }

    const result = fromCamera
      ? await ImagePicker.launchCameraAsync({ quality: 0.6, mediaTypes: ImagePicker.MediaTypeOptions.Images })
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.6, mediaTypes: ImagePicker.MediaTypeOptions.Images });

    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];

    setUploading(true);
    try {
      const uploaded = await uploadImage(asset.uri, asset.mimeType ?? "image/jpeg");
      const message = await api.sendMessage(orderId, { mediaId: uploaded.mediaId });
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
    } catch (e) {
      Alert.alert("Foto nicht gesendet", e instanceof ApiError ? e.message : "Bitte erneut versuchen.");
    } finally {
      setUploading(false);
    }
  }

  if (loading) {
    return <View style={styles.centred}><ActivityIndicator color={theme.colors.primary} /></View>;
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
        renderItem={({ item }) => <Bubble message={item} />}
        ListEmptyComponent={
          <Text style={styles.empty}>
            Schreib deinem Kurier — eure Telefonnummern bleiben dabei privat.
          </Text>
        }
      />

      {closed ? (
        <View style={styles.closedBanner}>
          <Text style={styles.closedText}>
            Dieser Chat ist geschlossen. Bei Problemen hilft dir der Support weiter.
          </Text>
        </View>
      ) : (
        <>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.quickRow}
            contentContainerStyle={styles.quickContent}
          >
            {quickReplies.map((reply) => (
              <Pressable key={reply} style={styles.quickChip} onPress={() => send(reply, "QUICK_REPLY")}>
                <Text style={styles.quickText}>{reply}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <View style={styles.composer}>
            <Pressable
              style={styles.iconButton}
              onPress={() => sendPhoto(true)}
              disabled={uploading}
              accessibilityLabel="Foto aufnehmen"
            >
              <Text style={styles.icon}>📷</Text>
            </Pressable>
            <Pressable
              style={styles.iconButton}
              onPress={() => sendPhoto(false)}
              disabled={uploading}
              accessibilityLabel="Foto auswählen"
            >
              <Text style={styles.icon}>🖼</Text>
            </Pressable>

            <TextInput
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              placeholder="Nachricht"
              placeholderTextColor={theme.colors.textMuted}
              multiline
              maxLength={1000}
            />

            <Pressable
              style={[styles.sendButton, (!draft.trim() || sending) && styles.sendDisabled]}
              onPress={() => send(draft)}
              disabled={!draft.trim() || sending}
            >
              <Text style={styles.sendText}>Senden</Text>
            </Pressable>
          </View>

          {uploading ? <Text style={styles.uploading}>Foto wird gesendet…</Text> : null}
        </>
      )}
    </KeyboardAvoidingView>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  const mine = message.sender === "CUSTOMER";
  const system = message.sender === "SYSTEM";

  if (system) {
    return <Text style={styles.systemMessage}>{message.body}</Text>;
  }

  return (
    <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
      {message.mediaUrl ? (
        <Image source={{ uri: message.mediaUrl }} style={styles.image} resizeMode="cover" />
      ) : null}
      {message.body ? (
        <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>{message.body}</Text>
      ) : null}
      <Text style={[styles.time, mine && styles.timeMine]}>
        {new Date(message.createdAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  centred: { flex: 1, alignItems: "center", justifyContent: "center" },
  list: { padding: theme.spacing(2), gap: theme.spacing(1) },
  empty: {
    ...theme.type.caption, color: theme.colors.textMuted,
    textAlign: "center", marginTop: theme.spacing(4), paddingHorizontal: theme.spacing(3), lineHeight: 20,
  },
  bubble: { maxWidth: "80%", borderRadius: theme.radius.md, padding: theme.spacing(1.25) },
  bubbleMine: { alignSelf: "flex-end", backgroundColor: theme.colors.primary },
  bubbleTheirs: { alignSelf: "flex-start", backgroundColor: theme.colors.surface },
  bubbleText: { ...theme.type.body, color: theme.colors.text },
  bubbleTextMine: { color: "#FFFFFF" },
  image: { width: 220, height: 165, borderRadius: theme.radius.sm, marginBottom: 6 },
  time: { ...theme.type.caption, fontSize: 11, color: theme.colors.textMuted, marginTop: 2, alignSelf: "flex-end" },
  timeMine: { color: "#D3EAE1" },
  systemMessage: {
    ...theme.type.caption, color: theme.colors.textMuted,
    textAlign: "center", marginVertical: theme.spacing(1),
  },
  quickRow: { flexGrow: 0, borderTopWidth: 1, borderTopColor: theme.colors.border },
  quickContent: { padding: theme.spacing(1), gap: theme.spacing(1) },
  quickChip: {
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing(1.5),
    paddingVertical: theme.spacing(1),
    borderRadius: 999,
  },
  quickText: { ...theme.type.caption, color: theme.colors.text },
  composer: {
    flexDirection: "row", alignItems: "flex-end", gap: theme.spacing(0.75),
    padding: theme.spacing(1),
    borderTopWidth: 1, borderTopColor: theme.colors.border,
  },
  iconButton: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: "center", justifyContent: "center",
    backgroundColor: theme.colors.surface,
  },
  icon: { fontSize: 20 },
  input: {
    flex: 1, maxHeight: 110,
    borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing(1.5), paddingVertical: theme.spacing(1),
    color: theme.colors.text, ...theme.type.body,
  },
  sendButton: {
    backgroundColor: theme.colors.primary, borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing(2), height: 44, justifyContent: "center",
  },
  sendDisabled: { opacity: 0.4 },
  sendText: { color: "#FFFFFF", fontWeight: "600" },
  uploading: { ...theme.type.caption, color: theme.colors.textMuted, textAlign: "center", paddingBottom: theme.spacing(1) },
  closedBanner: { padding: theme.spacing(2), borderTopWidth: 1, borderTopColor: theme.colors.border },
  closedText: { ...theme.type.caption, color: theme.colors.textMuted, textAlign: "center", lineHeight: 18 },
});
