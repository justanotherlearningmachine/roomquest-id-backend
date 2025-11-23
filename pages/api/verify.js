if (action === 'start') {
      const token = Math.random().toString(36).substring(2, 15);
      
      const { data } = await supabase
        .from('demo_sessions')
        .insert({ session_token: token })
        .select()
        .single();
      
      return res.json({ 
        session_token: token,
        verify_url: `/verify/${token}` 
      });
    }

    if (action === 'log_consent') {
      const { session_token, consent_given, consent_time, consent_locale } = req.body;
      
      if (!session_token) {
        return res.status(400).json({ error: 'Session token required' });
      }
      
      // Update the session with consent info
      const { error: updateError } = await supabase
        .from('demo_sessions')
        .update({
          consent_given,
          consent_time,
          consent_locale
        })
        .eq('session_token', session_token);
      
      if (updateError) {
        console.error('Error updating consent:', updateError);
        return res.status(500).json({ error: 'Failed to log consent' });
      }
      
      return res.json({ 
        success: true,
        message: 'Consent logged successfully'
      });
    }
