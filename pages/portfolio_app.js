const menu = document.querySelector('#mobile-menu');
const menuLinks = document.querySelector('.navbar__menu');

const letters = "ABCDEFHIJKLNPRSTUVZ";

menu.addEventListener('click', function() {
    menu.classList.toggle('is-active');
    menuLinks.classList.toggle('active');
});

document.querySelector("h1#nr").onmouseover = event => {
    let iterations = 0;

    const interval = setInterval(() => {
        event.target.innerText = event.target.innerText.split("")
        .map((letter, index) => {
            if (event.target.dataset.value[index] == " ") {
                return event.target.dataset.value[index];
            }
            
            if (index < iterations) {
                return event.target.dataset.value[index];
            }
            
            return letters[Math.floor(Math.random() * 19)]
        })
        .join("");

        if (iterations >= event.target.dataset.value.length) clearInterval(interval);

        iterations += 1/3;
    }, 30);

}

document.querySelector("h2#dp").onmouseover = event => {
    let iterations = 0;

    const interval = setInterval(() => {
        event.target.innerText = event.target.innerText.split("")
        .map((letter, index) => {
            if (event.target.dataset.value[index] == " ") {
                return event.target.dataset.value[index];
            }

            if (index < iterations) {
                return event.target.dataset.value[index];
            }
            
            return letters[Math.floor(Math.random() * 19)]
        })
        .join("");

        if (iterations >= event.target.dataset.value.length) clearInterval(interval);

        iterations += 1/3;
    }, 30);

}

const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
        console.log(entry)
        if (entry.isIntersecting) {
            entry.target.classList.add('show');
        } else {
            entry.target.classList.remove('show');
        }
    });
});

const hiddenElements = document.querySelectorAll('.hidden');
const hidden2Elements = document.querySelectorAll('.hidden2');
hiddenElements.forEach((el) => observer.observe(el));
hidden2Elements.forEach((el) => observer.observe(el));