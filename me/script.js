(function () {
    'use strict';

    const EMAIL = 'kamshion@outlook.com';
    const emailCard = document.querySelector('.email-card');

    if (!emailCard) return;

    function copyEmail(button) {
        const labelEl = button.querySelector('strong');
        const originalText = labelEl ? labelEl.textContent : '';

        function setCopiedState() {
            if (labelEl) labelEl.textContent = '已复制';
            setTimeout(function () {
                if (labelEl) labelEl.textContent = originalText;
            }, 1200);
        }

        function fallbackCopy() {
            const textarea = document.createElement('textarea');
            textarea.value = EMAIL;
            textarea.setAttribute('readonly', '');
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            textarea.setSelectionRange(0, EMAIL.length);

            try {
                const copied = document.execCommand('copy');
                if (copied) {
                    setCopiedState();
                } else {
                    alert('复制失败，请手动复制：' + EMAIL);
                }
            } catch (error) {
                alert('复制失败，请手动复制：' + EMAIL);
            } finally {
                document.body.removeChild(textarea);
            }
        }

        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(EMAIL)
                .then(function () {
                    setCopiedState();
                })
                .catch(function () {
                    fallbackCopy();
                });
            return;
        }

        fallbackCopy();
    }

    emailCard.addEventListener('click', function () {
        copyEmail(emailCard);
    });
})();
