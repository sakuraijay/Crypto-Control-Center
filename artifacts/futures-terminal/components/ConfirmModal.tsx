import React from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

interface Props {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  dangerous?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  visible, title, message,
  confirmLabel = 'Confirm',
  dangerous = false,
  onConfirm, onCancel,
}: Props) {
  const colors = useColors();
  const iconColor = dangerous ? colors.destructive : colors.warning;

  const handleConfirm = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    onConfirm();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.overlay}>
        <View style={[styles.box, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={[styles.iconWrap, { backgroundColor: iconColor + '22' }]}>
            <Feather name={dangerous ? 'alert-octagon' : 'alert-triangle'} size={26} color={iconColor} />
          </View>
          <Text style={[styles.title, { color: colors.foreground }]}>{title}</Text>
          <Text style={[styles.msg, { color: colors.mutedForeground }]}>{message}</Text>
          <View style={styles.btns}>
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: colors.secondary }]}
              onPress={onCancel}
              activeOpacity={0.75}
            >
              <Text style={[styles.btnTxt, { color: colors.foreground }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: iconColor }]}
              onPress={handleConfirm}
              activeOpacity={0.75}
            >
              <Text style={[styles.btnTxt, { color: '#FFFFFF' }]}>{confirmLabel}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: '#000000BB',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
  },
  box: {
    width: '100%',
    maxWidth: 340,
    borderRadius: 16,
    borderWidth: 1,
    padding: 24,
    alignItems: 'center',
    gap: 14,
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  title: {
    fontFamily: 'Inter_700Bold',
    fontSize: 17,
    textAlign: 'center',
  },
  msg: {
    fontFamily: 'Inter_400Regular',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 21,
  },
  btns: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
    marginTop: 6,
  },
  btn: {
    flex: 1,
    height: 46,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnTxt: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 15,
  },
});
