import { Box, Paper, Button, Alert } from '@mui/material';
import { Visibility as VisibilityIcon, Refresh as RefreshIcon, CheckCircle as CheckCircleIcon } from '@mui/icons-material';

interface HostControlsProps {
  isRevealed: boolean;
  allVoted: boolean;
  onReveal: () => void;
  onReset: () => void;
}

export function HostControls({ isRevealed, allVoted, onReveal, onReset }: HostControlsProps) {
  return (
    <Paper sx={{ p: 2, mb: 2 }}>
      {allVoted && !isRevealed && (
        <Alert
          severity="success"
          icon={<CheckCircleIcon />}
          sx={{ mb: 2 }}
        >
          全員がカードを選択しました！公開できます
        </Alert>
      )}
      {!allVoted && !isRevealed && (
        <Alert severity="info" sx={{ mb: 2 }}>
          未投票の参加者がいても、ホストはいつでもカードを公開できます
        </Alert>
      )}
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <Button
          variant="contained"
          color="inherit"
          onClick={onReset}
          startIcon={<RefreshIcon />}
        >
          リセット
        </Button>
        <Button
          variant="contained"
          onClick={onReveal}
          disabled={isRevealed}
          color={allVoted && !isRevealed ? 'success' : 'primary'}
          startIcon={<VisibilityIcon />}
          sx={allVoted && !isRevealed ? {
            animation: 'pulse 2s ease-in-out infinite',
            '@keyframes pulse': {
              '0%, 100%': { transform: 'scale(1)' },
              '50%': { transform: 'scale(1.05)' },
            },
          } : undefined}
        >
          {allVoted ? 'カードを公開' : '強制的にカードを公開'}
        </Button>
      </Box>
    </Paper>
  );
}
