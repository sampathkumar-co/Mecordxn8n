-- Correct Milestone H's upgrade-time operator bootstrap assumption.
-- Supported platform-operator identity is rooted in the auditable
-- PLATFORM_BOOTSTRAPPED security event. Self-serve workspace ownership
-- must never imply platform-wide operator access.

UPDATE platform_users u
   SET is_platform_operator = EXISTS (
     SELECT 1
       FROM workspace_security_events e
      WHERE e.user_id = u.id
        AND e.event_type = 'PLATFORM_BOOTSTRAPPED'
   )
 WHERE u.is_platform_operator = true
    OR EXISTS (
      SELECT 1
        FROM workspace_security_events e
       WHERE e.user_id = u.id
         AND e.event_type = 'PLATFORM_BOOTSTRAPPED'
    );
